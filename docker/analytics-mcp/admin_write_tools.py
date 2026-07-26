# Herramientas de escritura para la Admin API de Google Analytics (GA4).
#
# El paquete oficial "analytics-mcp" (ver analytics_mcp.tools.client) solo
# pide el scope OAuth "analytics.readonly", así que su cliente de Admin API
# puede leer configuración pero nunca modificarla. Este módulo construye un
# segundo cliente de Admin API que pide "analytics.edit" y expone las
# operaciones create/update/archive/delete que el cliente de solo lectura no
# puede hacer. Se fusionan con las tools de lectura en app.py sobre el mismo
# Server MCP.

import asyncio
import threading
from typing import Any, Dict, List, Optional

import google.auth
from google.adk.tools.function_tool import FunctionTool
from google.adk.tools.mcp_tool.conversion_utils import adk_to_mcp_tool_type
from google.analytics import admin_v1alpha, admin_v1beta
from google.api_core.gapic_v1.client_info import ClientInfo
from google.protobuf import field_mask_pb2

from analytics_mcp.coordinator import sanitize_mcp_schema_properties
from analytics_mcp.tools.utils import construct_property_rn, proto_to_dict

_EDIT_ANALYTICS_SCOPE = "https://www.googleapis.com/auth/analytics.edit"

_CLIENT_INFO = ClientInfo(user_agent="analytics-mcp-write-ext/1.0")

_client_lock = threading.Lock()
_CREDENTIALS = None


def _get_write_credentials():
    global _CREDENTIALS
    with _client_lock:
        if _CREDENTIALS is None:
            _CREDENTIALS, _ = google.auth.default(scopes=[_EDIT_ANALYTICS_SCOPE])
        return _CREDENTIALS


def create_admin_write_client() -> admin_v1beta.AnalyticsAdminServiceClient:
    """Returns a Google Analytics Admin API (v1beta) client with edit scope."""
    return admin_v1beta.AnalyticsAdminServiceClient(
        client_info=_CLIENT_INFO, credentials=_get_write_credentials()
    )


def create_admin_alpha_write_client() -> admin_v1alpha.AnalyticsAdminServiceClient:
    """Returns a Google Analytics Admin API (v1alpha) client with edit scope."""
    return admin_v1alpha.AnalyticsAdminServiceClient(
        client_info=_CLIENT_INFO, credentials=_get_write_credentials()
    )


def _enum(enum_cls, value: str, field: str):
    try:
        return enum_cls[value.upper()]
    except KeyError as exc:
        valid = ", ".join(member.name for member in enum_cls)
        raise ValueError(
            f"Invalid {field} '{value}'. Valid values: {valid}."
        ) from exc


# --- Custom dimensions --------------------------------------------------


async def create_custom_dimension(
    property_id: int | str,
    parameter_name: str,
    display_name: str,
    scope: str = "EVENT",
    description: str = "",
    disallow_ads_personalization: bool = False,
) -> Dict[str, Any]:
    """Creates a custom dimension on a GA4 property.

    Args:
        property_id: The GA4 property ID (a number, or 'properties/<number>').
        parameter_name: Tagging parameter name (event parameter name, or user
          property name when scope is USER, or item parameter name when scope
          is ITEM). Alphanumeric plus underscore, must start with a letter.
        display_name: Display name shown in the Analytics UI.
        scope: One of 'EVENT', 'USER', or 'ITEM'.
        description: Optional description (max 150 characters).
        disallow_ads_personalization: If true, excludes this dimension from
          ads personalization. Only supported for USER-scoped dimensions.
    """
    request = admin_v1beta.CreateCustomDimensionRequest(
        parent=construct_property_rn(property_id),
        custom_dimension=admin_v1beta.CustomDimension(
            parameter_name=parameter_name,
            display_name=display_name,
            description=description,
            scope=_enum(admin_v1beta.CustomDimension.DimensionScope, scope, "scope"),
            disallow_ads_personalization=disallow_ads_personalization,
        ),
    )

    def _sync_call():
        return create_admin_write_client().create_custom_dimension(request=request)

    response = await asyncio.to_thread(_sync_call)
    return proto_to_dict(response)


async def update_custom_dimension(
    name: str,
    display_name: Optional[str] = None,
    description: Optional[str] = None,
    disallow_ads_personalization: Optional[bool] = None,
) -> Dict[str, Any]:
    """Updates an existing custom dimension. Only the fields provided change.

    Args:
        name: Resource name, e.g. 'properties/1234/customDimensions/5678'.
        display_name: New display name, if changing.
        description: New description, if changing.
        disallow_ads_personalization: New value, if changing.
    """
    custom_dimension = admin_v1beta.CustomDimension(name=name)
    update_paths: List[str] = []
    if display_name is not None:
        custom_dimension.display_name = display_name
        update_paths.append("display_name")
    if description is not None:
        custom_dimension.description = description
        update_paths.append("description")
    if disallow_ads_personalization is not None:
        custom_dimension.disallow_ads_personalization = disallow_ads_personalization
        update_paths.append("disallow_ads_personalization")
    if not update_paths:
        raise ValueError("Provide at least one field to update.")

    request = admin_v1beta.UpdateCustomDimensionRequest(
        custom_dimension=custom_dimension,
        update_mask=field_mask_pb2.FieldMask(paths=update_paths),
    )

    def _sync_call():
        return create_admin_write_client().update_custom_dimension(request=request)

    response = await asyncio.to_thread(_sync_call)
    return proto_to_dict(response)


async def archive_custom_dimension(name: str) -> Dict[str, Any]:
    """Archives (soft-deletes) a custom dimension. Cannot be undone via the API.

    Args:
        name: Resource name, e.g. 'properties/1234/customDimensions/5678'.
    """
    request = admin_v1beta.ArchiveCustomDimensionRequest(name=name)

    def _sync_call():
        create_admin_write_client().archive_custom_dimension(request=request)

    await asyncio.to_thread(_sync_call)
    return {"status": "archived", "name": name}


# --- Custom metrics -------------------------------------------------------


async def create_custom_metric(
    property_id: int | str,
    parameter_name: str,
    display_name: str,
    measurement_unit: str = "STANDARD",
    description: str = "",
    restricted_metric_types: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """Creates a custom metric on a GA4 property. Scope is always EVENT.

    Args:
        property_id: The GA4 property ID (a number, or 'properties/<number>').
        parameter_name: Tagging (event parameter) name. Alphanumeric plus
          underscore, must start with a letter.
        display_name: Display name shown in the Analytics UI.
        measurement_unit: One of 'STANDARD', 'CURRENCY', 'FEET', 'METERS',
          'KILOMETERS', 'MILES', 'MILLISECONDS', 'SECONDS', 'MINUTES', 'HOURS'.
        description: Optional description (max 150 characters).
        restricted_metric_types: Required (['COST_DATA'] and/or
          ['REVENUE_DATA']) when measurement_unit is 'CURRENCY'; must be empty
          otherwise.
    """
    kwargs: Dict[str, Any] = {
        "parameter_name": parameter_name,
        "display_name": display_name,
        "description": description,
        "measurement_unit": _enum(
            admin_v1beta.CustomMetric.MeasurementUnit,
            measurement_unit,
            "measurement_unit",
        ),
        "scope": admin_v1beta.CustomMetric.MetricScope.EVENT,
    }
    if restricted_metric_types:
        kwargs["restricted_metric_type"] = [
            _enum(
                admin_v1beta.CustomMetric.RestrictedMetricType,
                value,
                "restricted_metric_types",
            )
            for value in restricted_metric_types
        ]

    request = admin_v1beta.CreateCustomMetricRequest(
        parent=construct_property_rn(property_id),
        custom_metric=admin_v1beta.CustomMetric(**kwargs),
    )

    def _sync_call():
        return create_admin_write_client().create_custom_metric(request=request)

    response = await asyncio.to_thread(_sync_call)
    return proto_to_dict(response)


async def update_custom_metric(
    name: str,
    display_name: Optional[str] = None,
    description: Optional[str] = None,
) -> Dict[str, Any]:
    """Updates an existing custom metric. Only the fields provided change.

    Args:
        name: Resource name, e.g. 'properties/1234/customMetrics/5678'.
        display_name: New display name, if changing.
        description: New description, if changing.
    """
    custom_metric = admin_v1beta.CustomMetric(name=name)
    update_paths: List[str] = []
    if display_name is not None:
        custom_metric.display_name = display_name
        update_paths.append("display_name")
    if description is not None:
        custom_metric.description = description
        update_paths.append("description")
    if not update_paths:
        raise ValueError("Provide at least one field to update.")

    request = admin_v1beta.UpdateCustomMetricRequest(
        custom_metric=custom_metric,
        update_mask=field_mask_pb2.FieldMask(paths=update_paths),
    )

    def _sync_call():
        return create_admin_write_client().update_custom_metric(request=request)

    response = await asyncio.to_thread(_sync_call)
    return proto_to_dict(response)


async def archive_custom_metric(name: str) -> Dict[str, Any]:
    """Archives (soft-deletes) a custom metric. Cannot be undone via the API.

    Args:
        name: Resource name, e.g. 'properties/1234/customMetrics/5678'.
    """
    request = admin_v1beta.ArchiveCustomMetricRequest(name=name)

    def _sync_call():
        create_admin_write_client().archive_custom_metric(request=request)

    await asyncio.to_thread(_sync_call)
    return {"status": "archived", "name": name}


# --- Key events (conversions) ---------------------------------------------


async def create_key_event(
    property_id: int | str,
    event_name: str,
    counting_method: str = "ONCE_PER_EVENT",
    default_value_numeric: Optional[float] = None,
    default_value_currency_code: Optional[str] = None,
) -> Dict[str, Any]:
    """Marks an event as a key event (conversion) on a GA4 property.

    Args:
        property_id: The GA4 property ID (a number, or 'properties/<number>').
        event_name: The event name to mark as a key event.
        counting_method: 'ONCE_PER_EVENT' or 'ONCE_PER_SESSION'.
        default_value_numeric: Default numeric value applied to occurrences
          missing a 'value' parameter. Must be set together with
          default_value_currency_code, or not at all.
        default_value_currency_code: ISO 4217 currency code (e.g. 'USD') for
          default_value_numeric.
    """
    if (default_value_numeric is None) != (default_value_currency_code is None):
        raise ValueError(
            "default_value_numeric and default_value_currency_code must be "
            "set together, or not at all."
        )

    kwargs: Dict[str, Any] = {
        "event_name": event_name,
        "counting_method": _enum(
            admin_v1beta.KeyEvent.CountingMethod, counting_method, "counting_method"
        ),
    }
    if default_value_numeric is not None:
        kwargs["default_value"] = {
            "numeric_value": default_value_numeric,
            "currency_code": default_value_currency_code,
        }

    request = admin_v1beta.CreateKeyEventRequest(
        parent=construct_property_rn(property_id),
        key_event=admin_v1beta.KeyEvent(**kwargs),
    )

    def _sync_call():
        return create_admin_write_client().create_key_event(request=request)

    response = await asyncio.to_thread(_sync_call)
    return proto_to_dict(response)


async def update_key_event(
    name: str,
    counting_method: Optional[str] = None,
    default_value_numeric: Optional[float] = None,
    default_value_currency_code: Optional[str] = None,
) -> Dict[str, Any]:
    """Updates an existing key event. Only the fields provided change.

    Args:
        name: Resource name, e.g. 'properties/1234/keyEvents/5678'.
        counting_method: New counting method ('ONCE_PER_EVENT' or
          'ONCE_PER_SESSION'), if changing.
        default_value_numeric: New default numeric value. Must be set
          together with default_value_currency_code, or not at all.
        default_value_currency_code: New default currency code. Must be set
          together with default_value_numeric, or not at all.
    """
    if (default_value_numeric is None) != (default_value_currency_code is None):
        raise ValueError(
            "default_value_numeric and default_value_currency_code must be "
            "set together, or not at all."
        )

    key_event = admin_v1beta.KeyEvent(name=name)
    update_paths: List[str] = []
    if counting_method is not None:
        key_event.counting_method = _enum(
            admin_v1beta.KeyEvent.CountingMethod, counting_method, "counting_method"
        )
        update_paths.append("counting_method")
    if default_value_numeric is not None:
        key_event.default_value = {
            "numeric_value": default_value_numeric,
            "currency_code": default_value_currency_code,
        }
        update_paths.append("default_value")
    if not update_paths:
        raise ValueError("Provide at least one field to update.")

    request = admin_v1beta.UpdateKeyEventRequest(
        key_event=key_event,
        update_mask=field_mask_pb2.FieldMask(paths=update_paths),
    )

    def _sync_call():
        return create_admin_write_client().update_key_event(request=request)

    response = await asyncio.to_thread(_sync_call)
    return proto_to_dict(response)


async def delete_key_event(name: str) -> Dict[str, Any]:
    """Deletes a key event. Only key events with deletable=true can be removed.

    Args:
        name: Resource name, e.g. 'properties/1234/keyEvents/5678'.
    """
    request = admin_v1beta.DeleteKeyEventRequest(name=name)

    def _sync_call():
        create_admin_write_client().delete_key_event(request=request)

    await asyncio.to_thread(_sync_call)
    return {"status": "deleted", "name": name}


# --- Audiences (v1alpha) ---------------------------------------------------


async def create_audience(
    property_id: int | str,
    display_name: str,
    description: str,
    membership_duration_days: int,
    filter_clauses: List[Dict[str, Any]],
    event_trigger: Optional[Dict[str, Any]] = None,
    exclusion_duration_mode: Optional[str] = None,
) -> Dict[str, Any]:
    """Creates an audience (a saved, reusable segment of users) on a GA4 property.

    Audience filters are expressed using the raw Admin API v1alpha JSON shape
    for the 'Audience' resource, since the filter grammar (AND/OR/NOT groups,
    simple vs. sequence filters, dimension/metric/event filters) is deeply
    nested. Example filter_clauses for "users on desktop":
    [{"clause_type": "INCLUDE", "simple_filter": {
        "scope": "AUDIENCE_FILTER_SCOPE_ACROSS_ALL_SESSIONS",
        "filter_expression": {"or_group": {"filter_expressions": [
            {"dimension_or_metric_filter": {
                "field_name": "deviceCategory",
                "string_filter": {"match_type": "EXACT", "value": "desktop"},
            }}
        ]}},
    }}]

    Args:
        property_id: The GA4 property ID (a number, or 'properties/<number>').
        display_name: The display name of the audience.
        description: The description of the audience.
        membership_duration_days: How long a user stays in the audience
          (max 540 days).
        filter_clauses: List of raw AudienceFilterClause objects (see above).
        event_trigger: Optional raw AudienceEventTrigger dict, e.g.
          {"event_name": "audience_joined", "log_condition": "AUDIENCE_JOINED"}.
        exclusion_duration_mode: 'EXCLUDE_TEMPORARILY' or
          'EXCLUDE_PERMANENTLY'. Only relevant if a filter clause has
          clause_type EXCLUDE.
    """
    kwargs: Dict[str, Any] = {
        "display_name": display_name,
        "description": description,
        "membership_duration_days": membership_duration_days,
        "filter_clauses": filter_clauses,
    }
    if event_trigger is not None:
        kwargs["event_trigger"] = event_trigger
    if exclusion_duration_mode is not None:
        kwargs["exclusion_duration_mode"] = _enum(
            admin_v1alpha.Audience.AudienceExclusionDurationMode,
            exclusion_duration_mode,
            "exclusion_duration_mode",
        )

    request = admin_v1alpha.CreateAudienceRequest(
        parent=construct_property_rn(property_id),
        audience=admin_v1alpha.Audience(**kwargs),
    )

    def _sync_call():
        return create_admin_alpha_write_client().create_audience(request=request)

    response = await asyncio.to_thread(_sync_call)
    return proto_to_dict(response)


async def update_audience(
    name: str,
    display_name: Optional[str] = None,
    description: Optional[str] = None,
) -> Dict[str, Any]:
    """Updates an existing audience. Only the fields provided change.

    Note: membership_duration_days and filter_clauses are immutable after
    creation and cannot be updated.

    Args:
        name: Resource name, e.g. 'properties/1234/audiences/5678'.
        display_name: New display name, if changing.
        description: New description, if changing.
    """
    audience = admin_v1alpha.Audience(name=name)
    update_paths: List[str] = []
    if display_name is not None:
        audience.display_name = display_name
        update_paths.append("display_name")
    if description is not None:
        audience.description = description
        update_paths.append("description")
    if not update_paths:
        raise ValueError("Provide at least one field to update.")

    request = admin_v1alpha.UpdateAudienceRequest(
        audience=audience,
        update_mask=field_mask_pb2.FieldMask(paths=update_paths),
    )

    def _sync_call():
        return create_admin_alpha_write_client().update_audience(request=request)

    response = await asyncio.to_thread(_sync_call)
    return proto_to_dict(response)


async def archive_audience(name: str) -> Dict[str, Any]:
    """Archives an audience. Cannot be undone via the API.

    Args:
        name: Resource name, e.g. 'properties/1234/audiences/5678'.
    """
    request = admin_v1alpha.ArchiveAudienceRequest(name=name)

    def _sync_call():
        create_admin_alpha_write_client().archive_audience(request=request)

    await asyncio.to_thread(_sync_call)
    return {"status": "archived", "name": name}


# --- Data streams -----------------------------------------------------


async def create_data_stream(
    property_id: int | str,
    stream_type: str,
    display_name: Optional[str] = None,
    web_stream_data: Optional[Dict[str, Any]] = None,
    android_app_stream_data: Optional[Dict[str, Any]] = None,
    ios_app_stream_data: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Creates a data stream (web, Android app, or iOS app) on a GA4 property.

    Args:
        property_id: The GA4 property ID (a number, or 'properties/<number>').
        stream_type: One of 'WEB_DATA_STREAM', 'ANDROID_APP_DATA_STREAM',
          'IOS_APP_DATA_STREAM'.
        display_name: Required for web streams. Max 255 characters.
        web_stream_data: Required if stream_type is 'WEB_DATA_STREAM', e.g.
          {"default_uri": "https://example.com"}.
        android_app_stream_data: Required if stream_type is
          'ANDROID_APP_DATA_STREAM', e.g. {"package_name": "com.example.app"}.
        ios_app_stream_data: Required if stream_type is
          'IOS_APP_DATA_STREAM', e.g. {"bundle_id": "com.example.app"}.
    """
    kwargs: Dict[str, Any] = {
        "type_": _enum(
            admin_v1beta.DataStream.DataStreamType, stream_type, "stream_type"
        )
    }
    if display_name is not None:
        kwargs["display_name"] = display_name
    if web_stream_data is not None:
        kwargs["web_stream_data"] = web_stream_data
    if android_app_stream_data is not None:
        kwargs["android_app_stream_data"] = android_app_stream_data
    if ios_app_stream_data is not None:
        kwargs["ios_app_stream_data"] = ios_app_stream_data

    request = admin_v1beta.CreateDataStreamRequest(
        parent=construct_property_rn(property_id),
        data_stream=admin_v1beta.DataStream(**kwargs),
    )

    def _sync_call():
        return create_admin_write_client().create_data_stream(request=request)

    response = await asyncio.to_thread(_sync_call)
    return proto_to_dict(response)


async def update_data_stream(
    name: str,
    display_name: Optional[str] = None,
    web_stream_data: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Updates an existing data stream. Only the fields provided change.

    Args:
        name: Resource name, e.g. 'properties/1234/dataStreams/5678'.
        display_name: New display name, if changing.
        web_stream_data: New web stream data (only 'default_uri' is
          mutable), e.g. {"default_uri": "https://example.com"}. Only valid
          for web data streams.
    """
    data_stream = admin_v1beta.DataStream(name=name)
    update_paths: List[str] = []
    if display_name is not None:
        data_stream.display_name = display_name
        update_paths.append("display_name")
    if web_stream_data is not None:
        data_stream.web_stream_data = web_stream_data
        update_paths.append("web_stream_data.default_uri")
    if not update_paths:
        raise ValueError("Provide at least one field to update.")

    request = admin_v1beta.UpdateDataStreamRequest(
        data_stream=data_stream,
        update_mask=field_mask_pb2.FieldMask(paths=update_paths),
    )

    def _sync_call():
        return create_admin_write_client().update_data_stream(request=request)

    response = await asyncio.to_thread(_sync_call)
    return proto_to_dict(response)


async def delete_data_stream(name: str) -> Dict[str, Any]:
    """Deletes a data stream from a GA4 property.

    Args:
        name: Resource name, e.g. 'properties/1234/dataStreams/5678'.
    """
    request = admin_v1beta.DeleteDataStreamRequest(name=name)

    def _sync_call():
        create_admin_write_client().delete_data_stream(request=request)

    await asyncio.to_thread(_sync_call)
    return {"status": "deleted", "name": name}


# --- Property settings -----------------------------------------------


async def update_property(
    property_id: int | str,
    display_name: Optional[str] = None,
    time_zone: Optional[str] = None,
    currency_code: Optional[str] = None,
    industry_category: Optional[str] = None,
) -> Dict[str, Any]:
    """Updates settings of a GA4 property. Only the fields provided change.

    Args:
        property_id: The GA4 property ID (a number, or 'properties/<number>').
        display_name: New display name, if changing.
        time_zone: New reporting time zone (IANA format, e.g.
          'America/Los_Angeles'), if changing.
        currency_code: New reporting currency (ISO 4217, e.g. 'USD'), if
          changing.
        industry_category: New industry category (e.g. 'RETAIL',
          'TECHNOLOGY', 'FINANCE'), if changing.
    """
    property_ = admin_v1beta.Property(name=construct_property_rn(property_id))
    update_paths: List[str] = []
    if display_name is not None:
        property_.display_name = display_name
        update_paths.append("display_name")
    if time_zone is not None:
        property_.time_zone = time_zone
        update_paths.append("time_zone")
    if currency_code is not None:
        property_.currency_code = currency_code
        update_paths.append("currency_code")
    if industry_category is not None:
        property_.industry_category = _enum(
            admin_v1beta.IndustryCategory, industry_category, "industry_category"
        )
        update_paths.append("industry_category")
    if not update_paths:
        raise ValueError("Provide at least one field to update.")

    request = admin_v1beta.UpdatePropertyRequest(
        property=property_,
        update_mask=field_mask_pb2.FieldMask(paths=update_paths),
    )

    def _sync_call():
        return create_admin_write_client().update_property(request=request)

    response = await asyncio.to_thread(_sync_call)
    return proto_to_dict(response)


# --- Google Ads links ------------------------------------------------


async def create_google_ads_link(
    property_id: int | str,
    customer_id: str,
    ads_personalization_enabled: Optional[bool] = None,
) -> Dict[str, Any]:
    """Links a GA4 property to a Google Ads account.

    Args:
        property_id: The GA4 property ID (a number, or 'properties/<number>').
        customer_id: The Google Ads customer ID (digits only, no dashes).
        ads_personalization_enabled: Whether to auto-publish GA4 audiences
          and remarketing signals to the linked Google Ads account. Defaults
          to true if not set.
    """
    kwargs: Dict[str, Any] = {"customer_id": customer_id}
    if ads_personalization_enabled is not None:
        kwargs["ads_personalization_enabled"] = ads_personalization_enabled

    request = admin_v1beta.CreateGoogleAdsLinkRequest(
        parent=construct_property_rn(property_id),
        google_ads_link=admin_v1beta.GoogleAdsLink(**kwargs),
    )

    def _sync_call():
        return create_admin_write_client().create_google_ads_link(request=request)

    response = await asyncio.to_thread(_sync_call)
    return proto_to_dict(response)


async def update_google_ads_link(
    name: str,
    ads_personalization_enabled: bool,
) -> Dict[str, Any]:
    """Updates an existing Google Ads link.

    Args:
        name: Resource name, e.g. 'properties/1234/googleAdsLinks/5678'.
        ads_personalization_enabled: New value for ads personalization.
    """
    request = admin_v1beta.UpdateGoogleAdsLinkRequest(
        google_ads_link=admin_v1beta.GoogleAdsLink(
            name=name, ads_personalization_enabled=ads_personalization_enabled
        ),
        update_mask=field_mask_pb2.FieldMask(paths=["ads_personalization_enabled"]),
    )

    def _sync_call():
        return create_admin_write_client().update_google_ads_link(request=request)

    response = await asyncio.to_thread(_sync_call)
    return proto_to_dict(response)


async def delete_google_ads_link(name: str) -> Dict[str, Any]:
    """Removes a Google Ads link from a GA4 property.

    Args:
        name: Resource name, e.g. 'properties/1234/googleAdsLinks/5678'.
    """
    request = admin_v1beta.DeleteGoogleAdsLinkRequest(name=name)

    def _sync_call():
        create_admin_write_client().delete_google_ads_link(request=request)

    await asyncio.to_thread(_sync_call)
    return {"status": "deleted", "name": name}


# --- MCP tool registration --------------------------------------------

tools = [
    FunctionTool(create_custom_dimension),
    FunctionTool(update_custom_dimension),
    FunctionTool(archive_custom_dimension),
    FunctionTool(create_custom_metric),
    FunctionTool(update_custom_metric),
    FunctionTool(archive_custom_metric),
    FunctionTool(create_key_event),
    FunctionTool(update_key_event),
    FunctionTool(delete_key_event),
    FunctionTool(create_audience),
    FunctionTool(update_audience),
    FunctionTool(archive_audience),
    FunctionTool(create_data_stream),
    FunctionTool(update_data_stream),
    FunctionTool(delete_data_stream),
    FunctionTool(update_property),
    FunctionTool(create_google_ads_link),
    FunctionTool(update_google_ads_link),
    FunctionTool(delete_google_ads_link),
]

tool_map = {t.name: t for t in tools}

mcp_tools = [adk_to_mcp_tool_type(tool) for tool in tools]

for _tool in mcp_tools:
    if _tool.inputSchema == {}:
        _tool.inputSchema = {"type": "object", "properties": {}}
    for _prop in _tool.inputSchema.get("properties", {}).values():
        if "anyOf" in _prop and _prop.get("type") == "null":
            del _prop["type"]
    sanitize_mcp_schema_properties(_tool.inputSchema)
