import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, Security
from fastapi.middleware.cors import CORSMiddleware
from rich import print

from auth import load_jwks, validate_token
from telemetry import configure_telemetry

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    load_jwks()
    yield


app = FastAPI(lifespan=lifespan)

tracer, meter = configure_telemetry(app, service_name="python-app")

# Custom metrics
hello_counter = meter.create_counter(
    name="hello.requests",
    description="Number of hello requests",
    unit="1",
)
hello_duration = meter.create_histogram(
    name="hello.duration_ms",
    description="Duration of hello endpoint processing in milliseconds",
    unit="ms",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET"],
    allow_headers=["*"],
)


@app.get("/")
def read_root():
    logger.info("Root endpoint called")
    return {"message": "Hello from Python + uv + VS Code!"}


@app.get("/hello/{name}")
def hello(name: str, request: Request, user: dict = Security(validate_token)):
    import time
    start = time.perf_counter()

    with tracer.start_as_current_span("hello") as span:
        span.set_attribute("hello.name", name)
        logger.info("Hello request for name: %s", name)

        hello_counter.add(1, {"name": name})

        result = {"message": f"Hello, {name}!"}

    elapsed_ms = (time.perf_counter() - start) * 1000
    hello_duration.record(elapsed_ms, {"name": name})

    return result


def main():
    print("[bold green]Hello from Python + uv + VS Code![/bold green]")


if __name__ == "__main__":
    main()

