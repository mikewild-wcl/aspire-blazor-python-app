import logging
import os

from opentelemetry import metrics, trace
from opentelemetry._logs import set_logger_provider
from opentelemetry.exporter.otlp.proto.grpc._log_exporter import OTLPLogExporter
from opentelemetry.exporter.otlp.proto.grpc.metric_exporter import OTLPMetricExporter
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.sdk._logs import LoggerProvider, LoggingHandler
from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor


def configure_telemetry(app, service_name: str = "python-app"):
    """Configure OpenTelemetry tracing, metrics and logging for a FastAPI app.

    Local dev: exports to the Aspire dashboard via OTLP (OTEL_EXPORTER_OTLP_ENDPOINT).
    Deployed:  also exports to Azure Application Insights when
               APPLICATIONINSIGHTS_CONNECTION_STRING is present.
    """
    otlp_endpoint = os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4317")
    service_name = os.getenv("OTEL_SERVICE_NAME", service_name)
    ai_connection_string = os.getenv("APPLICATIONINSIGHTS_CONNECTION_STRING")

    resource = Resource.create({"service.name": service_name})

    # --- Tracing ---
    tracer_provider = TracerProvider(resource=resource)
    tracer_provider.add_span_processor(
        BatchSpanProcessor(OTLPSpanExporter(endpoint=otlp_endpoint))
    )
    if ai_connection_string:
        from azure.monitor.opentelemetry.exporter import AzureMonitorTraceExporter
        tracer_provider.add_span_processor(
            BatchSpanProcessor(AzureMonitorTraceExporter(connection_string=ai_connection_string))
        )
    trace.set_tracer_provider(tracer_provider)

    # --- Metrics ---
    metric_readers = [
        PeriodicExportingMetricReader(
            OTLPMetricExporter(endpoint=otlp_endpoint),
            export_interval_millis=10_000,
        )
    ]
    if ai_connection_string:
        from azure.monitor.opentelemetry.exporter import AzureMonitorMetricExporter
        metric_readers.append(
            PeriodicExportingMetricReader(
                AzureMonitorMetricExporter(connection_string=ai_connection_string),
                export_interval_millis=10_000,
            )
        )
    meter_provider = MeterProvider(resource=resource, metric_readers=metric_readers)
    metrics.set_meter_provider(meter_provider)

    # --- Logging ---
    logger_provider = LoggerProvider(resource=resource)
    logger_provider.add_log_record_processor(
        BatchLogRecordProcessor(OTLPLogExporter(endpoint=otlp_endpoint))
    )
    if ai_connection_string:
        from azure.monitor.opentelemetry.exporter import AzureMonitorLogExporter
        logger_provider.add_log_record_processor(
            BatchLogRecordProcessor(AzureMonitorLogExporter(connection_string=ai_connection_string))
        )
    set_logger_provider(logger_provider)
    logging.getLogger().addHandler(
        LoggingHandler(level=logging.NOTSET, logger_provider=logger_provider)
    )

    # Auto-instrument all FastAPI routes (adds HTTP server spans + attributes)
    FastAPIInstrumentor.instrument_app(app)

    return trace.get_tracer(service_name), metrics.get_meter(service_name)
