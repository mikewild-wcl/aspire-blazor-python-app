# Architecture Review: Edge, Networking and Security Enhancements

**Date:** 2026-06-11
**Scope:** Review of the Azure deployment architecture (Container Apps via Aspire/azd) with recommendations for Azure Front Door and private networking. No code changes have been made — this document is the plan.

---

## 1. Current architecture

The AppHost (`AspirePy.AppHost/AppHost.cs`) models:

| Resource | Aspire declaration | Azure result (publish mode) |
|---|---|---|
| Container Apps environment | `AddAzureContainerAppEnvironment("env")` | ACA environment (workload profiles, Microsoft-managed VNet), Azure Container Registry, Log Analytics workspace, user-assigned managed identity |
| Blazor web app | `AddProject<Projects.AspirePy_Web>("web").WithExternalHttpEndpoints()` | Container app with **external** ingress (public FQDN) |
| Python FastAPI | `AddUvicornApp("python-app", …).WithExternalHttpEndpoints()` | Container app with **external** ingress (public FQDN) |
| Application Insights | `AddAzureApplicationInsights("app-insights")` (publish only) | App Insights + connection string injected via OTLP/Azure Monitor exporter |
| Entra ID config | Four `AddParameter(...)` values, client secret marked `secret: true` | Container app secrets / env vars |

Traffic flow today:

```
Internet ──► web (public ACA FQDN, Entra OIDC cookie auth)
Internet ──► python-app (public ACA FQDN, JWT bearer validation)   ⚠ unnecessary exposure
web ──► python-app (via ACA internal service discovery + bearer token)
```

### What is already good

- **Authentication is solid end-to-end**: OIDC + cookies on the web app; the Python API validates Entra-issued JWTs (signature via JWKS, audience, issuer) on every request.
- **Service-to-service calls use Entra tokens** (`ITokenAcquisition` → `access_as_user` scope), not shared secrets.
- **Observability** is in place: OpenTelemetry in both apps exported to Application Insights, provisioned only in publish mode so local runs need no Azure credentials.
- **Aspire owns the infrastructure model**, so the changes below can mostly be expressed in the AppHost rather than hand-maintained Bicep.

### Gaps identified

1. **The Python API is publicly reachable.** `WithExternalHttpEndpoints()` on `python-app` gives it its own internet-facing FQDN. Only the web app calls it. JWT validation protects it logically, but it is needlessly exposed to scanning, DDoS and any future auth misconfiguration. *(Highest priority, smallest fix.)*
2. **No edge layer in front of the web app.** The public ACA FQDN is the front door: no WAF, no global edge/anycast, no caching of static assets, no custom-domain/cert management story, and DDoS protection is only ACA's platform baseline.
3. **No private networking.** The environment uses the Microsoft-managed VNet with public inbound. Nothing forces traffic through an edge layer; there are no NSGs, no subnet to place private endpoints for future dependencies (databases, Key Vault, storage).
4. **The Entra client secret is a long-lived credential** stored as a container app secret via an azd parameter. It must be rotated manually and appears in deployment state.
5. **Blazor Server scale-out is unaddressed.** Interactive Server circuits are stateful; with more than one replica, sticky sessions are required at every hop.

---

## 2. Recommended target architecture

```
Internet
   │
   ▼
Azure Front Door Premium  (WAF, custom domain + managed cert, edge TLS, caching)
   │  Private Link (origin type: managedEnvironments)
   ▼
ACA environment — internal-only, public network access DISABLED
   ├── web         (external ingress within the env → reachable via Front Door only)
   └── python-app  (internal ingress → reachable from web only)
        ▲
        └── Entra JWT validation retained (defence in depth)
```

Key decisions and rationale:

| Decision | Recommendation | Why |
|---|---|---|
| Front Door tier | **Premium** | Private Link origins are not supported on Standard. Premium also includes managed WAF rules and bot protection. |
| Origin connectivity | **Private endpoint to the ACA environment** (`managedEnvironments` sub-resource) | Network-level guarantee that the only path in is Front Door. Stronger than `X-Azure-FDID` header checks, and compatible with zone-redundant environments (the ILB/Private Link Service topology is not). |
| Custom VNet | **Optional, phase 2b** | Front Door + Private Link works against the managed VNet with public access disabled. Bring your own VNet only when you need NSGs, egress control (NAT Gateway/Firewall), or private endpoints to other services in the same network. |
| Python API exposure | **Internal ingress only** | Keep the JWT validation; remove the public FQDN. |
| Blazor Server | Enable **sticky sessions** on the web container app ingress and **session affinity** on the Front Door route; keep `minReplicas ≥ 1` | Circuits are stateful; cold-start also hurts OIDC redirects. Front Door supports WebSockets, which Blazor Server requires. |
| Client secret | Replace with **managed identity as a federated identity credential** on the Entra app registration (or, at minimum, move the secret to Key Vault) | Eliminates (or centralises) the long-lived secret. |

### Cost note

Front Door Premium has a meaningful base cost (~US$330/month plus traffic) and private endpoints on ACA are billed extra. If that is disproportionate for this workload, the fallback is **Front Door Standard + public origin**, restricting the origin with ACA IP security restrictions to the `AzureFrontDoor.Backend` service tag and validating the `X-Azure-FDID` header in the web app. That is weaker (header check, not network isolation) but far cheaper. The plan below assumes Premium; the fallback only changes phase 3.

---

## 3. Implementation plan

### Phase 1 — Quick wins (AppHost only, no new Azure services)

**1a. Make the Python API internal.** In `AppHost.cs`, remove `WithExternalHttpEndpoints()` from `python-app`:

```csharp
var python = builder.AddUvicornApp(
        name: "python-app",
        appDirectory: "../pyapp",
        app: "main:app")
    .WithUv()
    .WithHttpEndpoint(env: "PORT")        // internal ingress only
    .WithEnvironment("ENTRA_TENANT_ID", entraTenantId)
    .WithEnvironment("ENTRA_CLIENT_ID", entraApiClientId);
```

Nothing else changes: `web` reaches it through ACA's internal ingress using the same service-discovery URL (`https+http://python-app`), and the JWT validation stays as defence in depth. Local development is unaffected.

**1b. Sticky sessions + minimum replicas for the Blazor app.** Blazor Interactive Server needs affinity once the app scales past one replica:

```csharp
using Azure.Provisioning.AppContainers;

var web = builder.AddProject<Projects.AspirePy_Web>("web")
    // ... existing config ...
    .PublishAsAzureContainerApp((infra, app) =>
    {
        app.Configuration.Ingress.StickySessionsAffinity = StickySessionAffinity.Sticky;
        app.Template.Scale.MinReplicas = 1;
    });
```

(`Azure.Provisioning.AppContainers` is already transitively available via `Aspire.Hosting.Azure.AppContainers`.)

**1c. (Recommended) Remove the client secret.** Configure the Entra app registration with the container app's user-assigned managed identity as a **federated identity credential**, and switch `Microsoft.Identity.Web` to that credential type — then delete the `entra-client-secret` parameter. If staying with a secret short-term, add `builder.AddAzureKeyVault("kv")` and store it there instead of as a plain container app secret.

### Phase 2 — Lock down inbound networking

> Order matters: deploy Front Door (phase 3) **before** disabling public access, or do both in one `azd up` — otherwise the site is unreachable in between.

**2a. Disable public network access on the environment** (works with the managed VNet — no custom VNet required):

```csharp
using Azure.Provisioning.AppContainers;

builder.AddAzureContainerAppEnvironment("env")
    .ConfigureInfrastructure(infra =>
    {
        var env = infra.GetProvisionableResources()
                       .OfType<ContainerAppManagedEnvironment>()
                       .Single();
        env.PublicNetworkAccess = ContainerAppPublicNetworkAccess.Disabled;
    });
```

After this, the environment is reachable only through approved private endpoints (i.e., Front Door's).

**2b. (Optional) Bring your own VNet.** Only needed for NSGs, controlled egress, or co-locating private endpoints to other Azure services. Add the `Azure.Provisioning.Network` package to the AppHost and extend the same callback:

```csharp
using Azure.Provisioning.Network;

.ConfigureInfrastructure(infra =>
{
    var vnet = new VirtualNetwork("vnet")
    {
        AddressPrefixes = { "10.0.0.0/16" },
        Subnets =
        {
            new SubnetResource("aca-infra")     // delegated to Microsoft.App/environments, /23 minimum
            {
                AddressPrefix = "10.0.0.0/23",
                Delegations = { new ServiceDelegation { Name = "aca", ServiceName = "Microsoft.App/environments" } }
            },
            new SubnetResource("private-endpoints") { AddressPrefix = "10.0.2.0/24" }
        }
    };
    infra.Add(vnet);

    var env = infra.GetProvisionableResources()
                   .OfType<ContainerAppManagedEnvironment>()
                   .Single();
    env.VnetConfiguration = new ContainerAppVnetConfiguration
    {
        InfrastructureSubnetId = vnet.Subnets[0].Id,
        IsInternal = true
    };
    env.PublicNetworkAccess = ContainerAppPublicNetworkAccess.Disabled;
});
```

> The exact `Azure.Provisioning.Network` subnet/delegation type names should be confirmed against the package version at implementation time; the ACA requirements are fixed: a dedicated subnet delegated to `Microsoft.App/environments`, `/23` or larger for workload profile environments, plus a separate non-delegated subnet for private endpoints.

### Phase 3 — Azure Front Door Premium with Private Link

There is no first-class `AddAzureFrontDoor(...)` integration in Aspire 13, so model it in the AppHost using one of:

- **Option A (recommended): `AddBicepTemplate`** — a hand-written `infra/frontdoor.bicep` referenced from the AppHost. Easiest to review and matches the well-documented Bicep shape for AFD.
- **Option B: `AddAzureInfrastructure`** — build the same resources in C# with `Azure.Provisioning.Cdn` (profile, endpoint, origin group, origin with `sharedPrivateLinkResource`, route) and `Azure.Provisioning.FrontDoor` (WAF policy). More code, but no Bicep files.

Option A wiring:

```csharp
var frontDoor = builder.AddBicepTemplate("frontdoor", "../infra/frontdoor.bicep")
    .WithParameter("originHostName", /* web app FQDN output */)
    .WithParameter("environmentId",  /* ACA environment resource ID */);
```

The Bicep template needs to define:

| Resource | Key settings |
|---|---|
| `Microsoft.Cdn/profiles` | SKU `Premium_AzureFrontDoor` |
| `afdEndpoints` | the public hostname |
| `originGroups` + `origins` | origin = the **web** container app FQDN; `sharedPrivateLinkResource` targeting the ACA environment ID with `groupId: 'managedEnvironments'` |
| `routes` | HTTPS redirect on, link to default domain, **session affinity enabled** |
| `securityPolicies` + WAF policy (`Microsoft.Network/frontdoorWebApplicationFirewallPolicies`) | Managed rule set (e.g. `Microsoft_DefaultRuleSet` + `Microsoft_BotManagerRuleSet`), start in `Detection`, move to `Prevention` |
| (later) custom domain | AFD-managed certificate, DNS CNAME/TXT validation |

**Manual/scripted step — approve the private endpoint:** AFD's Private Link request to the ACA environment must be approved (`az network private-endpoint-connection approve …`). Automate it as an azd `postprovision` hook in `azure.yaml`; note AFD sometimes creates multiple connection requests — approve each. Until approved, Front Door returns errors for the origin.

**Required application changes (web app) when fronted by AFD:**

1. **Forwarded headers**: configure `ForwardedHeadersOptions` (or set the public origin explicitly) so OIDC redirect URIs are generated with the Front Door/custom-domain hostname rather than the ACA FQDN.
2. **Entra app registration**: add the Front Door hostname (and later the custom domain) to the redirect URIs, e.g. `https://<endpoint>.azurefd.net/signin-oidc`.
3. Verify WebSockets (Blazor circuit) works end-to-end through AFD; affinity must be on at both the AFD route and ACA ingress (phase 1b).

### Phase rollout order

| Step | Action | Downtime risk |
|---|---|---|
| 1 | Phase 1 (internal API, sticky sessions, secret hygiene) → `azd up` | None |
| 2 | Phase 3 Front Door deployed **with the origin still public**; approve private endpoint; add redirect URI; test via AFD hostname | None |
| 3 | Phase 2a disable public network access → `azd up` | Brief window if PE not yet approved — verify first |
| 4 | (Optional) Phase 2b custom VNet; custom domain + WAF `Prevention` mode | VNet change recreates the environment — plan as a redeploy |

> **Warning:** switching an existing environment into a custom VNet is not an in-place update — ACA environments cannot move VNets. Phase 2b implies tearing down and re-provisioning the environment (`azd down` / new environment name), so decide on it before the architecture solidifies.

---

## 4. Items considered and not recommended (for now)

- **Application Gateway instead of Front Door** — regional rather than global, no edge caching, and you manage scaling/certs more directly. Only preferable if everything must stay inside one VNet/region or if Front Door Premium cost is prohibitive *and* WAF is mandatory.
- **API Management in front of the Python API** — overkill for a single internal consumer; the Entra JWT validation already covers authn/authz. Revisit if the API gains external consumers.
- **Azure Firewall / NAT Gateway egress control** — adds significant cost; only needed if compliance requires fixed egress IPs or outbound inspection. Requires phase 2b first.
- **Multi-region active/active** — Front Door makes this easy to add later (second origin in the origin group); not justified by current scale.

## 5. Summary of AppHost changes

| Change | API | Phase |
|---|---|---|
| Python API internal-only | remove `WithExternalHttpEndpoints()`, use `WithHttpEndpoint(env: "PORT")` | 1 |
| Sticky sessions / min replicas on web | `PublishAsAzureContainerApp((infra, app) => …)` — `Ingress.StickySessionsAffinity`, `Template.Scale.MinReplicas` | 1 |
| Secret hygiene | managed identity federated credential (preferred) or `AddAzureKeyVault("kv")` | 1 |
| Disable public inbound on environment | `AddAzureContainerAppEnvironment("env").ConfigureInfrastructure(...)` — `PublicNetworkAccess = Disabled` | 2a |
| Custom VNet (optional) | same callback — `VnetConfiguration { InfrastructureSubnetId, IsInternal }` + `Azure.Provisioning.Network` | 2b |
| Front Door Premium + WAF + Private Link | `AddBicepTemplate("frontdoor", …)` (or `AddAzureInfrastructure` + `Azure.Provisioning.Cdn`) + azd `postprovision` hook for PE approval | 3 |

All `Azure.Provisioning.AppContainers` member names above (`PublicNetworkAccess`, `VnetConfiguration.InfrastructureSubnetId`, `VnetConfiguration.IsInternal`, `Ingress.StickySessionsAffinity`) were verified against the package shipped with Aspire 13.4.
