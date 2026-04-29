# From a FastAPI experiment in VS Code to a cloud-ready Aspire app

Some projects start with an architecture diagram. This one started with a few practical notes: install the Python extension in VS Code, create a `pyapp` folder, use `uv`, wire up a debug profile, and see if a tiny FastAPI service can be made pleasant to work on.

The git history shows how that small experiment grew over about a month into a full .NET Aspire sample: a Python FastAPI backend, a Blazor Server frontend, shared OpenTelemetry, Application Insights in Azure, repeatable deployment with `azd`, and finally Microsoft Entra authentication. What I like about the history is that it reads less like a big-bang design and more like a developer tightening one loop at a time.

By the end, the solution had four main pieces:

- `AspirePy.AppHost` for orchestration and cloud wiring
- `AspirePy.ServiceDefaults` for .NET service discovery, resilience, and telemetry defaults
- `AspirePy.Web` for the Blazor Server UI
- `pyapp` for the Python FastAPI service

## Starting where the feedback loop is fastest

The earliest notes in the repo are all about the Python developer experience. They talk about creating a virtual environment with `uv`, selecting the interpreter in VS Code, adding `fastapi` and `uvicorn`, and setting up a `.vscode/launch.json` so the service can be debugged normally.

That is exactly the right way to start a cross-language project. Before bringing in orchestration, cloud resources, or a frontend, the developer first made sure the Python part felt natural on its own. The first real `pyapp` commit adds the pieces you would expect from a modern Python app:

- `pyproject.toml` as the dependency source of truth
- `uv.lock` committed for reproducible installs
- a tiny `main.py`
- a VS Code debug profile

The first endpoint was deliberately simple. It returned a plain JSON message: `"Hello from Python + uv + VS Code!"`. That sounds trivial, but it established the core idea of the whole project: Python would not be hidden behind a .NET wrapper. It would remain a normal FastAPI app, developed with Python tools, and then connected into a wider system.

Even the rough edges were documented early. The repo includes notes about `uv` on a corporate network, where TLS interception can make `uv sync` fail with `UnknownIssuer`. That detail matters. It is the difference between a toy sample and something another developer can actually clone and run on a work machine.

## Bringing Aspire in early

The first commit in the branch already contains an `AppHost` and a `ServiceDefaults` project. That tells you the end goal was not just "make FastAPI work", but "make FastAPI a first-class part of a distributed application".

The key move was using Aspire's Python hosting support instead of treating Python as an afterthought:

```csharp
var python = builder.AddUvicornApp(
        name: "python-app",
        appDirectory: "../pyapp",
        app: "main:app")
    .WithUv()
    .WithExternalHttpEndpoints();
```

This is a small amount of code, but it changes the shape of the project. Aspire becomes responsible for starting the FastAPI app, wiring its endpoint, and making it discoverable to the rest of the solution. At the same time, the Python service still lives in its own folder, still uses `uv`, and still runs as a normal Uvicorn application.

The README captures two problems that had to be solved during this stage, and they are exactly the kind of problems you hit when you do this for real. First, `AddUvicornApp` already creates an `http` endpoint, so adding another one manually leads to a naming conflict. Second, the integration only works cleanly if the FastAPI app is exposed exactly as `main:app` and the correct Python packages are installed. Those are small issues, but they explain why the first commit is part scaffolding and part field notes. The developer was not just building the app; they were learning the edges of the Python/Aspire integration and writing the lessons down as they went.

## Adding a Blazor frontend gave the API a purpose

Once the Python service was running inside Aspire, the next step makes perfect sense: add a real client. In practice, the Python app and the Blazor frontend landed on the same day — a few hours apart — which tells you the developer had a clear picture of where things were heading. By the end of that day, the sample had gone from "a Python app under orchestration" to "two services that actually talk to each other".

The first version of the Blazor app was still mostly template code. The home page was the standard welcome screen. But that quickly turned into a purpose-built page for sending a name to the Python API and displaying the response. The UI stayed intentionally small because the real point was not visual design. The point was proving that a .NET frontend could discover and call a Python backend without hardcoded ports or ad hoc configuration.

The most important line in the web app is probably this one:

```csharp
builder.Services.AddHttpClient("python-app", client =>
{
    client.BaseAddress = new Uri("https+http://python-app");
});
```

That `https+http://python-app` URI is one of the nicest pieces of the whole sample. It means the Blazor app talks to the Python service by Aspire resource name, not by localhost port. Locally, Aspire resolves that name to the right assigned endpoint. In a deployed environment, the same code can resolve to the internal address supplied by the platform. The developer never has to turn the web app into a pile of environment-specific URLs.

This is also where `AspirePy.ServiceDefaults` starts to earn its place. Service discovery and resilience get applied consistently to `HttpClient`, so the cross-language call path looks like a normal .NET-to-.NET service call even though one side is Python.

By this point the project had crossed an important line. It was no longer just a backend experiment. It had become a minimal, understandable end-to-end application.

## Observability came before more features

The next part of the history is my favorite because it shows good instincts. Before adding deployment or auth, the developer added observability.

The first telemetry pass happened in Python. A new `telemetry.py` file configured OpenTelemetry for traces, metrics, and logs, and `configure_telemetry(app)` was called before the routes were defined. That mattered because the FastAPI app was meant to behave like a real service from the beginning, not a demo that only became observable later.

Inside `pyapp/main.py`, the `/hello/{name}` endpoint started doing a little more than returning a greeting. It created a manual `hello` span, incremented a `hello.requests` counter, and recorded a `hello.duration_ms` histogram. That was a smart move. The app is small enough that every custom metric is easy to understand, which makes it a great sample for showing how OpenTelemetry feels in practice.

At this stage the telemetry target was the Aspire dashboard via OTLP. That gave the developer immediate local feedback: traces flowing between services, basic metrics, and logs in one place, without needing any Azure resources.

A little later the telemetry story grew up. The AppHost began provisioning Application Insights, but only when the app was running in publish mode:

```csharp
if (builder.ExecutionContext.IsPublishMode)
{
    var insights = builder.AddAzureApplicationInsights("app-insights");
    python.WithReference(insights);
    web.WithReference(insights);
}
```

That design choice is one of the best in the repo. It keeps local development clean and fast: no Azure credentials, no cloud dependencies, no extra setup just to run the sample. But when the app is deployed, Aspire injects `APPLICATIONINSIGHTS_CONNECTION_STRING` and both runtimes light up their Azure Monitor exporters automatically.

On the .NET side, the shared service defaults check for the connection string before enabling Azure Monitor. On the Python side, `telemetry.py` conditionally imports the Azure Monitor exporter only when that environment variable exists. The result is elegant: the same codebase supports a lightweight local observability story and a cloud observability story without forks or special cases.

Somewhere around this period the repo also moved to central package management, which feels like the sort of cleanup that happens once a small sample starts to feel like a real solution rather than a scratch project.

## Deployment turned the sample into something repeatable

Once the local experience was solid, the history moves toward deployment. The addition of `docs/azure-deployment.md` is revealing because it shows the project becoming more than a personal experiment. The developer was now documenting how another person would actually get the thing into Azure.

The deployment path is built around `azd` and Aspire's Azure integration. Eventually that becomes concrete in two important places: the addition of `azure.yaml`, and a change in the AppHost to explicitly own the Container Apps environment.

```csharp
builder.AddAzureContainerAppEnvironment("env");
```

That single line moves the deployment into what Aspire calls normal mode. Instead of letting `azd` create infrastructure in a more opaque way, the AppHost becomes the source of truth for the Container Apps environment. That is a subtle but important shift. It means the developer can keep infrastructure decisions close to the application model instead of scattering them across generated artifacts.

The deployment guide reads like it was written by someone who hit the real problems and then cleaned them up for the next person. It covers the happy path: `azd init`, `azd up`, Azure Container Registry, Container Apps, and Application Insights. But it also talks about the practical issues that come up in the real world: cached deployments that do not refresh when you expect, conflicts caused by `WithAzdResourceNaming()`, Python container builds that depend on `uv.lock`, the need for SDK container support on the Blazor project, and even Windows path problems when a username contains a space.

That kind of troubleshooting section is not glamorous, but it tells you the project had gone through the important transition from "works on my machine" to "has a credible deployment story".

It also reinforces the shape of the architecture. The Python app is not being deployed as a sidecar or a special case. It becomes a first-class containerized service alongside the Blazor app, and Aspire keeps the service-to-service wiring intact in Azure just as it does locally.

## Authentication was the final step from demo to pattern

The last major feature in the branch history is Microsoft Entra authentication, and it is exactly the feature that turns the sample from a nice demo into a reusable pattern.

Until this point, the project proved that .NET and Python could be orchestrated together, discovered by name, observed with OpenTelemetry, and deployed to Azure. What it had not yet proved was a realistic secured call from the frontend to the backend. The auth work closes that loop.

On the Blazor side, the app uses OpenID Connect through `Microsoft.Identity.Web`:

```csharp
builder.Services.AddAuthentication(OpenIdConnectDefaults.AuthenticationScheme)
    .AddMicrosoftIdentityWebApp(builder.Configuration.GetSection("AzureAd"))
    .EnableTokenAcquisitionToCallDownstreamApi()
    .AddInMemoryTokenCaches();
```

That gives the web app two jobs: sign the user in and acquire an access token for the Python API. The AppHost supplies the Entra tenant ID, client ID, client secret, and API client ID as parameters, so the setup stays centralized. Importantly, the same API client ID flows to both sides: the web app uses it to construct the token scope (`api://{api-client-id}/access_as_user`), and the Python app uses it as the expected audience when validating incoming tokens. That symmetry is managed entirely through AppHost parameters — neither service needs to know the other's configuration directly.

The Python side is just as important. A new `auth.py` uses Entra's JWKS endpoint to fetch signing keys and validate Bearer tokens. It checks the token signature, audience, and issuer, and the FastAPI route itself becomes protected through `Security(validate_token)`. The web app's `PythonApiService` then acquires a token for the `api://{client-id}/access_as_user` scope and sends it as a Bearer token on the call to `/hello/{name}`.

That is a clean, modern cross-stack auth flow. The web app keeps its cookie-based interactive login experience, but the downstream call to Python still uses a proper access token. The Python service does not need to understand Blazor or cookies. It only needs to validate JWTs like any other API.

At the UI level the change is small: the home page now requires `[Authorize]`, and the web app exposes login and logout endpoints. Architecturally, though, it is the biggest step in the entire repo. It proves that the sample is not just about starting services. It is about building a secure boundary between them.

## What the finished project says about Aspire

By the end of the history, AspirePy is still deliberately small. The core business feature is just a greeting flowing from a Blazor page to a FastAPI endpoint and back again. That small scope is a strength, not a weakness, because it makes the platform decisions easy to see.

The project shows a few things very clearly:

1. Python can stay Python. The backend still uses FastAPI, Uvicorn, `uv`, and a normal VS Code workflow.
2. Aspire can orchestrate cross-language services without flattening them into the same development model.
3. Service discovery is much cleaner when services talk to each other by resource name instead of hardcoded ports.
4. OpenTelemetry is most useful when it arrives early, before the system becomes complicated.
5. Cloud wiring gets much easier when local development and deployment share the same application model.
6. Authentication is the point where a demo becomes a real application pattern.

What I like most is that the project did not jump straight to the final shape. The commit history shows the developer earning the architecture step by step. First make Python pleasant. Then wrap it in Aspire. Then give it a frontend. Then make it observable. Then deploy it. Then secure it.

That is a sensible order. Each step preserves the feedback loop from the previous one, and none of the early work gets thrown away.

If you only looked at the finished repository, you would see a neat Aspire solution with a Blazor frontend and a Python backend. The branch history tells a more useful story: this is what it looks like when a small developer experiment grows into an observable, deployable, authenticated application without losing the simplicity that made it fun to build in the first place.

### Source code
[!NOTE] 
> Source code is available on [GitHub](https://github.com/)

## References

### Pipelines

- [Pipe dreams to pipeline realities: an Aspire Pipelines story | Aspire Blog](https://devblogs.microsoft.com/aspire/aspire-pipelines/)
- [Exploring the New Aspire 13 Pipeline Model: Customizable, Flexible, and Future-Ready – RaspeR87&#39;s Blog](https://rasper87.blog/2025/11/06/exploring-the-new-aspire-13-pipeline-model-customizable-flexible-and-future-ready/)
- [davidfowl/aspire-ai-chat-demo: Aspire AI Chat is a full-stack chat sample that combines modern technologies to deliver a ChatGPT-like experience.](https://github.com/davidfowl/aspire-ai-chat-demo)