# Copilot Instructions — AspirePy

## Solution overview

This is a .NET 10 Aspire solution that orchestrates a **Blazor Server** frontend (`AspirePy.Web`) and a **Python FastAPI** backend (`pyapp`) with full OpenTelemetry observability and Azure Application Insights support.

```
AspirePy/
├── AspirePy.AppHost/          # Aspire orchestration entry point
├── AspirePy.ServiceDefaults/  # Shared .NET telemetry + service discovery config
├── AspirePy.Web/              # Blazor Server frontend (net10.0)
└── pyapp/                     # Python FastAPI backend (Python 3.14, uv)
```

## Technology stack

- **.NET 10**, C#, Blazor Server (`@rendermode InteractiveServer`)
- **Aspire 13.x** (`Aspire.AppHost.Sdk`) for orchestration
- **Python 3.14** with **uv** for package management
- **FastAPI** + **Uvicorn** for the Python API
- **OpenTelemetry** (OTLP → Aspire dashboard in dev; Azure Monitor in prod)
- **Central Package Management** via `Directory.Packages.props`

## Project-specific conventions

### NuGet packages
- All versions are in `Directory.Packages.props` — **never add `Version` to a `<PackageReference>`**
- Common MSBuild properties (`TargetFramework`, `Nullable`, `ImplicitUsings`) are in `Directory.Build.props` — do not repeat them in individual `.csproj` files

### Blazor
- All interactive components use `@rendermode InteractiveServer`
- Scoped CSS goes in `ComponentName.razor.css` — never use `<style>` blocks inline
- State that must survive navigation is stored in a scoped service (e.g. `GreetingState`)
- The layout (`MainLayout.razor`) is **static** — interactive behaviour is extracted into child components
- `HttpClient` is registered with `https+http://` scheme for Aspire service discovery

### Python / FastAPI
- Package manager is **uv** — use `uv add <package>` not pip
- All OTel configuration is in `pyapp/telemetry.py`
- `configure_telemetry(app)` must be called before any routes are defined
- The Azure Monitor exporter is conditionally imported only when `APPLICATIONINSIGHTS_CONNECTION_STRING` is set — do not import it unconditionally
- `pyproject.toml` is the source of truth for dependencies; `uv.lock` is committed

### Aspire AppHost
- Application Insights is **publish-mode only** — always guard with `builder.ExecutionContext.IsPublishMode`
- Service names in `AddProject` / `AddUvicornApp` must match the `HttpClient` name used in `Program.cs` for service discovery to resolve correctly
- The Python resource name is `"python-app"` — this must match `builder.Services.AddHttpClient("python-app", ...)`

### Telemetry
- Local dev: OTLP → Aspire dashboard (automatic, no config needed)
- Deployed: OTLP + Azure Monitor (connection string injected by Aspire/azd)
- Both the .NET and Python apps check for `APPLICATIONINSIGHTS_CONNECTION_STRING` at runtime before activating Azure Monitor exporters

## uv SSL configuration

### Standard machine

No extra configuration needed — `uv sync` works out of the box.

### Corporate machine (SSL interception)

If `uv sync` fails with `invalid peer certificate: UnknownIssuer`, create a merged CA bundle and point uv at it.

Set in PowerShell profile (`notepad $PROFILE`):
```powershell
$env:SSL_CERT_FILE      = "<certs-path>\merged-ca-bundle.pem"
$env:REQUESTS_CA_BUNDLE = "<certs-path>\merged-ca-bundle.pem"
```

`%APPDATA%\uv\uv.toml`:
```toml
native-tls = true
```

To (re-)create the merged bundle:
```powershell
$cacert = "$env:APPDATA\uv\python\cpython-3.14-windows-x86_64-none\Lib\site-packages\pip\_vendor\certifi\cacert.pem"
$corp   = "<certs-path>\<corporate-ca>.cer"
$merged = "<certs-path>\merged-ca-bundle.pem"
Get-Content $cacert | Set-Content $merged
Get-Content $corp   | Add-Content $merged
```

Re-run the merge whenever `certifi` updates.

## Git commit messages

Use the **Conventional Commits** format:

```
<type>(<scope>): <short summary>
```

**Types:**
- `feat` — new feature
- `fix` — bug fix
- `docs` — documentation changes only
- `style` — formatting, no logic change
- `refactor` — code restructure, no behaviour change
- `test` — adding or updating tests
- `chore` — build, tooling, dependencies

**Rules:**
- Summary is lowercase, no trailing period, max 72 characters
- Scope is optional but encouraged (e.g. `blazor`, `python`, `apphost`, `telemetry`, `deps`)
- Use the imperative mood: "add feature" not "added feature"
- Add a blank line between summary and body if a body is needed

**Examples:**
```
feat(blazor): add greeting state persistence across navigation
fix(apphost): guard app insights behind IsPublishMode
docs: update readme with ssl certificate setup
chore(deps): update Aspire.Hosting.Python to 13.3.1
refactor(python): extract telemetry config into separate module
```

## Key files

| File | Purpose |
|---|---|
| `AspirePy.AppHost/AppHost.cs` | Aspire resource definitions and wiring |
| `Directory.Packages.props` | All NuGet package versions |
| `Directory.Build.props` | Shared MSBuild properties |
| `AspirePy.ServiceDefaults/Extensions.cs` | OTel + service discovery + resilience |
| `AspirePy.Web/Program.cs` | Blazor app setup, `GreetingState` registration |
| `AspirePy.Web/GreetingState.cs` | Scoped state for greeting result persistence |
| `AspirePy.Web/Components/Pages/Home.razor` | Main page — name input + API call |
| `AspirePy.Web/Components/Layout/AboutButton.razor` | Interactive About modal (isolated from static layout) |
| `pyapp/main.py` | FastAPI routes |
| `pyapp/telemetry.py` | OpenTelemetry configuration for Python |
| `pyapp/pyproject.toml` | Python dependencies |
