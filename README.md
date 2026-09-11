# Python integration for Aspire

## Python setup

Make sure the Python extension is installed in VS code.

Set up a folder with a Python virtual environment for your project.
```
md pyapp
cd pyapp
uv venv --python 3.14
.venv\Scripts\activate.bat
```

Open the project and set the Python interpreter to the virtual environment using the `Python: Select Interpreter` command.

To add packages use `uv add <package-name>`. This will create a `pyproject.toml` file with the dependency information. In this project we will use `uv add rich` to add the Rich library for rich text and beautiful formatting in the terminal. 

To add required packages for FastAPI, use `uv add fastapi uvicorn`.

To add packages from an existing requirements.txt file, use `uv add -r requirements.txt`.

To enable debugging, add a `.vscode/launch.json' file.`

## Authentication (Microsoft Entra)

The Blazor frontend authenticates users via OpenID Connect (OIDC) against Microsoft Entra, and the Python FastAPI backend validates Bearer tokens issued by Entra. Two app registrations are required.

### Entra app registrations

| Registration | Entra name | Purpose |
|---|---|---|
| API (resource) | `aspire-py-api` | Defines the API scope that the web app requests |
| Web client | `aspire-py-web` | Authenticates users and acquires tokens for the API |

#### Creating the registrations

**Step 1 — API registration** (`aspire-py-api`, create this first):
1. In [Azure Portal](https://portal.azure.com) → **Microsoft Entra ID** → **App registrations** → **New registration**
2. Name: `aspire-py-api`, account type: *Accounts in this organizational directory only*, no redirect URI
3. Register → note the **Application (client) ID** and **Directory (tenant) ID**
4. **Expose an API** → **Add** next to *Application ID URI* → accept the default (`api://{client-id}`) → Save
5. **Add a scope**: name `access_as_user`, who can consent: *Admins and users*

**Step 2 — Web client registration** (`aspire-py-web`):
1. **New registration**, name: `aspire-py-web`, account type: *Accounts in this organizational directory only*
2. Redirect URI: **Web** → `https://localhost:7260/signin-oidc` *(add more URIs here after deployment)*
3. Register → note the **Application (client) ID**
4. **Certificates & secrets** → **New client secret** → note the **Value** immediately (shown once)
5. **API permissions** → **Add a permission** → **My APIs** → `aspire-py-api` → Delegated → `access_as_user` → Add
6. **Grant admin consent** for your tenant

### Local development setup

Store the four values as Aspire parameters in the AppHost user secrets (run once from the `AspirePy.AppHost/` directory):

```powershell
dotnet user-secrets set "Parameters:entra-tenant-id"     "<Directory (tenant) ID>"
dotnet user-secrets set "Parameters:entra-client-id"     "<aspire-py-web Application ID>"
dotnet user-secrets set "Parameters:entra-client-secret" "<aspire-py-web secret value>"
dotnet user-secrets set "Parameters:entra-api-client-id" "<aspire-py-api Application ID>"
```

Aspire injects these as environment variables at startup — no changes to `appsettings.json` are needed.

### How it works

- **Blazor** authenticates users via OIDC and stores the session in a cookie. When calling the Python API, `PythonApiService` acquires a Bearer token scoped to `api://{api-client-id}/access_as_user` via `ITokenAcquisition`.
- **Python FastAPI** validates the Bearer token on the `/hello/{name}` endpoint using Entra's JWKS endpoint (`PyJWT`). It checks the token signature, issuer, and audience.
- **Deployed secrets**: when running `azd up`, Aspire prompts for the four values and stores them securely in Azure Container Apps secrets — no extra configuration needed.


Add the Python integration package `Aspire.Hosting.Python` to the AppHost project. 

Add a uv app - this one uses FastAPI:
```
var python = builder.AddUvicornApp(
        name: "python-app",
        appDirectory: "../pyapp",
        app: "main:app")
    .WithUv()
    .WithExternalHttpEndpoints();
```

### Troubleshooting 
In the initial development a few issues had to be fixed.

#### 1. Endpoint name 'http' already exists
`AddUvicornApp` implicitly creates an HTTP endpoint named `http`. Calling `.WithHttpEndpoint` manually with conflicting ports or environment variables (like `PORT`) will cause a startup failure. To fix this, simply use `.WithExternalHttpEndpoints()` and remove the redundant `.WithHttpEndpoint()` call.

#### 2. Application fails to start (uvicorn missing / app not found)
For Uvicorn to start properly, make sure:
- The correct dependencies are installed and tracked in `pyproject.toml` (e.g., `uv add fastapi uvicorn`).
- You are chaining `.WithUv()` to your `AddUvicornApp` builder so Aspire can automatically restore packages on startup.
- Your `main.py` actually defines a FastAPI app instance (e.g., `app = FastAPI()`) that matches the configured target (`"main:app"`).

## Blazor frontend with service discovery

The solution includes an `AspirePy.Web` Blazor Server app that calls the Python FastAPI service. The Blazor app is registered in the AppHost and receives a reference to the Python resource:

```csharp
builder.AddProject<Projects.AspirePy_Web>("web")
    .WithReference(python);
```

### How service discovery works

Rather than hardcoding a host or port, the `HttpClient` is registered using the Aspire resource name as the hostname with the `https+http://` scheme:

```csharp
builder.Services.AddHttpClient("python-app", client =>
{
    client.BaseAddress = new Uri("https+http://python-app");
});
```

Aspire injects environment variables (e.g. `services__python-app__http__0`) at startup that the service discovery resolver reads to determine the real address and port. This means:

| Environment | How the address is resolved |
|---|---|
| **Local dev** | Resolved to `localhost:<assigned-port>` via injected environment variables |
| **Cloud (ACA / AKS)** | Resolved to the internal DNS name and port injected by the platform |

The port is never hardcoded — it is always read from the environment, so the app works without any changes whether running locally or deployed to the cloud.

The `https+http://` scheme prefix tells the client to prefer HTTPS but fall back to HTTP, making it portable across environments that may or may not have TLS configured.

Service discovery and resilience handlers are enabled globally for all `HttpClient` instances via `AddServiceDefaults()` in `ServiceDefaults/Extensions.cs`:

```csharp
builder.Services.ConfigureHttpClientDefaults(http =>
{
    http.AddStandardResilienceHandler();
    http.AddServiceDiscovery();
});
```

## OpenTelemetry and Application Insights

### How telemetry works

The FastAPI app (`pyapp/telemetry.py`) exports all three OpenTelemetry signals — traces, metrics, and logs — over OTLP gRPC. The Blazor app uses the standard Aspire `ServiceDefaults` configuration.

| Signal | Local dev | Deployed (Azure) |
|---|---|---|
| Traces | Aspire dashboard (OTLP) | Aspire dashboard + Application Insights |
| Metrics | Aspire dashboard (OTLP) | Aspire dashboard + Application Insights |
| Logs | Aspire dashboard (OTLP) | Aspire dashboard + Application Insights |

The Python app includes custom instrumentation on the `/hello/{name}` endpoint:
- **`hello.requests`** counter — incremented per call, tagged with the caller's name
- **`hello.duration_ms`** histogram — records processing time for latency analysis
- A manual `hello` span with a `hello.name` attribute for trace drill-down

### Application Insights setup

Application Insights is managed entirely through the AppHost. It is **only provisioned during `azd` deployment** — no Azure credentials or connection strings are needed when running locally.

```csharp
// AppHost.cs — only runs during publish, not local dev
if (builder.ExecutionContext.IsPublishMode)
{
    var insights = builder.AddAzureApplicationInsights("app-insights");
    python.WithReference(insights);
    web.WithReference(insights);
}
```

At deploy time, `azd` creates an Application Insights resource and injects `APPLICATIONINSIGHTS_CONNECTION_STRING` into both containers. Each app activates its Azure Monitor exporter only when that variable is present:

- **Blazor** (`ServiceDefaults/Extensions.cs`): `UseAzureMonitor()` guarded by `!string.IsNullOrEmpty(builder.Configuration["APPLICATIONINSIGHTS_CONNECTION_STRING"])`
- **Python** (`pyapp/telemetry.py`): `AzureMonitorTraceExporter` / `AzureMonitorMetricExporter` / `AzureMonitorLogExporter` guarded by `os.getenv("APPLICATIONINSIGHTS_CONNECTION_STRING")`

To test with a real App Insights instance during local development, add the connection string to the AppHost's user secrets:
```json
{
  "ConnectionStrings": {
    "app-insights": "InstrumentationKey=...;IngestionEndpoint=..."
  }
}
```

### uv SSL configuration

#### Standard machine (no corporate SSL interception)

No extra configuration is needed. `uv sync` will work out of the box.

#### Corporate machine (SSL inspection / custom CA certificates)

If `uv sync` fails with `invalid peer certificate: UnknownIssuer`, your organisation's SSL inspection proxy is intercepting HTTPS traffic using a private CA certificate that uv does not trust by default.

The fix is to create a merged CA bundle that combines the standard `certifi` bundle with your corporate CA certificate, then point uv at it.

**Step 1 — Create a merged CA bundle** (replace `<corporate-ca>` and `<certs-path>` with your actual paths):
```powershell
$cacert  = "$env:APPDATA\uv\python\cpython-3.14-windows-x86_64-none\Lib\site-packages\pip\_vendor\certifi\cacert.pem"
$corp    = "<certs-path>\<corporate-ca>.cer"   # your corporate CA certificate
$merged  = "<certs-path>\merged-ca-bundle.pem"  # output — choose any writable location
Get-Content $cacert | Set-Content $merged
Get-Content $corp   | Add-Content $merged
```

**Step 2 — Set permanently** (add to PowerShell profile via `notepad $PROFILE`):
```powershell
$env:SSL_CERT_FILE      = "<certs-path>\merged-ca-bundle.pem"
$env:REQUESTS_CA_BUNDLE = "<certs-path>\merged-ca-bundle.pem"
```

**Step 3 — Add a user-level uv config** at `%APPDATA%\uv\uv.toml`:
```toml
native-tls = true
```

> **Note:** Re-run the Step 1 merge command whenever `certifi` updates, as the base bundle will be replaced.

## Central Package Management

All NuGet package versions are managed centrally in `Directory.Packages.props` at the solution root. Individual `.csproj` files reference packages **without** a `Version` attribute.

To update a package, change its version in `Directory.Packages.props` only — no need to touch individual project files.

Common `<PropertyGroup>` properties (`TargetFramework`, `Nullable`, `ImplicitUsings`) are defined once in `Directory.Build.props` and inherited by all projects. Only project-specific properties remain in each `.csproj`.

### References and notes

 - https://devblogs.microsoft.com/aspire/python-is-first-class-in-aspire-13/
 - [Setup Guide: Python, uv, and VS Code – Foundations of Analytics &amp; AI](https://joelrrdavis.github.io/foundations-analytics-ai/guides/setup_python_uv_vscode.html)
 - [Mastering &quot;uv&quot; in VS Code: The Ultra-Fast Python Setup Guide - DEV Community](https://dev.to/lifeportal20002010/mastering-uv-in-vs-code-the-ultra-fast-python-setup-guide-2n56)
 - [Python integration | Aspire](https://aspire.dev/integrations/frameworks/python/)
 - [Add Uvicorn app](https://aspire.dev/integrations/frameworks/python/#add-uvicorn-app)
 - [Running a Python FastAPI (Uvicorn) service from .NET Aspire](https://rasper87.blog/2025/10/28/running-a-python-fastapi-uvicorn-service-from-net-aspire/)

### Notes
 - [Deploying ML Models as API using FastAPI](https://www.geeksforgeeks.org/machine-learning/machine-learning-deployment/)
 - [How to Implement Tool Calling with Gemma 4 and Python - MachineLearningMastery.com](https://machinelearningmastery.com/how-to-implement-tool-calling-with-gemma-4-and-python/)
    (Includes code for getting weather)

### OTEL
 - https://aspire.dev/dashboard/standalone-for-python/
 - https://www.linkedin.com/pulse/implementing-fastapi-python-opentelemetry-net-aspire-chandran-e3crc/
 - https://www.freecodecamp.org/news/build-end-to-end-llm-observability-in-fastapi-with-opentelemetry/
 - https://opentelemetry-python-contrib.readthedocs.io/en/latest/instrumentation/fastapi/fastapi.html

### gRPC
 - [Use gRPC with FastAPI](https://mojoauth.com/grpc/use-grpc-with-fastapi)

## React frontend API base URL (known limitation for containerized publish)

The React app (`AspirePy.AppHost/AppHost.cs`) resolves the Python API's URL via:

```csharp
builder.AddViteApp("frontend-react", "../frontend-react")
    .WithNpm()
    .WithReference(python)
    .WithEnvironment("VITE_API_BASE_URL", python.GetEndpoint("http"))
    .WaitFor(python);
```

`ApiHealth.tsx` reads `import.meta.env.VITE_API_BASE_URL` and calls `${VITE_API_BASE_URL}/health`. This works for local dev (`aspire run`) because Vite's dev server reads `process.env` live on each start.

**This will not work for a containerized production build.** Vite bakes `VITE_*` variables into the static bundle at `vite build` time, but the real Python app URL (an internal Container Apps FQDN) is only known at deploy/runtime — it doesn't exist yet when the Docker image is built.

### Fix to implement before containerized publish

Switch to a runtime-config-fetch pattern instead of a build-time env var:
1. Pass the Python API URL to the frontend container as a normal (non-`VITE_`) runtime env var.
2. Have the container's startup (an entrypoint script, or whatever serves the static build — nginx, a tiny Node static server) write it into a `config.json` or inject a `window.__CONFIG__` script tag at container start.
3. Have `ApiHealth.tsx` fetch that config on mount instead of reading `import.meta.env.VITE_API_BASE_URL` directly.

Revisit this once `frontend-react` gets a real publish/container path in the AppHost (currently only `AddViteApp` + `WithNpm`, no Dockerfile/container publish wired up yet).

## Architecture - Recommendations

An architecture review (June 2026) assessed whether the deployment needs additional Azure services such as Front Door or improved private networking. The full plan, including verified AppHost code snippets, is in [docs/architecture-review.md](docs/architecture-review.md).

**TLDR: yes, the architecture should be enhanced — but the single most important fix is one line, not a new service.** The Python FastAPI app is declared with `WithExternalHttpEndpoints()` in `AspirePy.AppHost/AppHost.cs`, so it gets its own public internet-facing FQDN even though only the Blazor app calls it. Its JWT validation is good defence, but it shouldn't be exposed at all. Beyond that, adding Front Door Premium with Private Link and disabling public access on the Container Apps environment is the right enhancement for a publicly accessible Blazor app.

### Recommendations, in rollout order

1. **Phase 1 (AppHost-only quick wins):** make `python-app` internal-ingress only; enable sticky sessions and `minReplicas: 1` on the web app (Blazor Server circuits are stateful, so affinity is required before it ever scales past one replica); and replace the long-lived Entra client secret with a managed-identity federated credential (or at least Key Vault).
2. **Phase 3 before 2 (ordering matters):** deploy **Azure Front Door Premium** with a WAF policy and a Private Link origin targeting the ACA environment (`managedEnvironments` sub-resource), approve the private endpoint connection (automatable as an azd `postprovision` hook), and add the Front Door hostname to the Entra redirect URIs plus forwarded-headers handling in the web app. Aspire 13 has no built-in Front Door integration, so the plan recommends `AddBicepTemplate` (with `AddAzureInfrastructure`/`Azure.Provisioning.Cdn` as the all-C# alternative).
3. **Then disable public network access** on the environment via `ConfigureInfrastructure` — this gives a network-level guarantee that Front Door is the only way in, which is stronger than `X-Azure-FDID` header checks. A custom VNet is optional (phase 2b): Front Door + Private Link works fine against the managed VNet, and switching VNets later means re-provisioning the environment, so that decision is flagged explicitly in the plan.

### Caveats

- Front Door **Premium** is required (Standard doesn't support Private Link origins) and costs roughly $330/month base — a cheaper Standard-tier fallback with IP restrictions and `X-Azure-FDID` header validation is described in the plan if that's disproportionate.
- The `Azure.Provisioning.AppContainers` API names used in the plan's code snippets (`PublicNetworkAccess`, `VnetConfiguration.IsInternal`, `StickySessionsAffinity`) were verified against the actual package shipped with Aspire 13.4; only the `Azure.Provisioning.Network` subnet types are marked for confirmation at implementation time.