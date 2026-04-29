# Azure Deployment Guide

This solution uses [Azure Developer CLI (`azd`)](https://aka.ms/azd) with Aspire's built-in `azd` integration to deploy to Azure Container Apps.

## Prerequisites

### 1. Install Azure Developer CLI

```powershell
winget install Microsoft.Azd
```

Restart your terminal after installing so `azd` is available in your PATH.

Verify the installation:

```powershell
azd version
```

### 2. Docker Desktop

Docker Desktop must be **running** during deployment. Container images are built locally and pushed to Azure Container Registry as part of `azd up`.

Download from: https://www.docker.com/products/docker-desktop

### 3. Azure subscription

You need an active Azure subscription with permission to create:

- Resource groups
- Azure Container Apps environment
- Azure Container Registry
- Azure Application Insights

---

## Deployment steps

### Authenticate

```powershell
azd auth login
```

### Initialise the project

Run this once from the repository root. Aspire is auto-detected and an `azure.yaml` file will be generated.

```powershell
cd C:\<path-to-repo>
azd init
```

When prompted, choose your Azure subscription and a target region. You do not need to set the subscription in advance — `azd init` will list your available subscriptions and let you pick one interactively.

If you need to switch subscriptions after the initial setup, run `azd init` first to create an environment, then override the subscription:

```powershell
azd env set AZURE_SUBSCRIPTION_ID <your-subscription-id>
```

> **Note:** `azd env set` requires an environment to already exist (created by `azd init`). It cannot be used before initialising.

Commit the generated `azure.yaml` to source control:

```powershell
git add azure.yaml
git commit -m "chore(deploy): add azd azure.yaml"
```

> **Note:** The `.azure/` folder contains local environment state and secrets and is already in `.gitignore` — do not commit it.

### Provision and deploy

```powershell
azd up
```

This single command:

1. Provisions all Azure resources
2. Builds container images for the Blazor and FastAPI apps
3. Pushes images to Azure Container Registry
4. Deploys to Azure Container Apps
5. Wires up Application Insights connection strings automatically

---

## Container Apps environment ownership

The `AppHost.cs` includes an explicit Container Apps environment declaration:

```csharp
builder.AddAzureContainerAppEnvironment("env");
```

This means Aspire — not `azd` — owns and manages the Azure Container Apps environment. This is **normal mode** and is the recommended approach from Aspire 9.4 onwards. Without this line, `azd` would display a "limited mode" warning and you would have less control over the hosting infrastructure.

The benefit of normal mode is that any future customisation of the Container Apps environment (scaling rules, ingress, custom domains, etc.) can be done directly in `AppHost.cs` rather than through generated Bicep files.

---

## What gets provisioned

Because Application Insights is gated to publish mode in `AppHost.cs`, `azd up` automatically:

| Resource | Details |
|---|---|
| Azure Container Apps environment | Hosts both the Blazor and Python containers |
| Azure Container Registry | Stores built container images |
| Azure Application Insights | Telemetry for both .NET and Python apps |
| Managed networking | Service-to-service communication between apps |

The `APPLICATIONINSIGHTS_CONNECTION_STRING` environment variable is injected into both apps by Aspire — no manual configuration is required.

---

## Subsequent deployments

After the initial `azd init` / `azd up`, use:

```powershell
# Re-deploy code changes only (no re-provisioning)
azd deploy

# Re-provision and re-deploy everything
azd up
```

---

## Teardown

To delete all provisioned Azure resources:

```powershell
azd down
```

## Pipeline

To create an Azure DevOps pipeline, run

You will need `azd` installed.

You need to have or create a Personal Access Token (PAT)
 - Sign into your Azure DevOps organization.
 - Go to the User settings menu and select Personal access tokens.
 - click + New Token.
 - Assign the following scopes to the token.
	 - Agent Pools (read, manage)
	 - Build (read and execute)
	 - Code (full)
	 - Project and team (read, write, and manage)
	 - Release (read, write, execute, and manage)
	 - Service Connections (read, query, and manage)
 - Click Create. Copy the token to a secure location.

You'll be prompted for the PAT during pipeline setup, but you can avoid that by saving it as an environment 
variable (OPTIONAL)
```powershell
[System.Environment]::SetEnvironmentVariable("AZURE_DEVOPS_EXT_PAT", "<PAT>", "User")
```

To create a pipeline, run the following command: 
```
azd pipeline config --provider azdo
```

You'll be prompted for a few things, including the Azure DvOps organization name, the PAT (if you haven't saved it as an environment variable, the repo origin, and a few other details - this all depends on whether you already have the project set up in Azure DevOps. Some of the things you might be prompted for are:
 - entra_api_client_id
 - entra_client_id
 - entra_client_secret
 - entra_tenant_id
 - PAT (as discussed above)
 - If you don't have an `.azdo\pipelines\azure-dev.yml` file you will be asked if you want to create it - say yes.
 - Federated User Managed Identity (MSI + OIDC)
 - How to authenticate the pipeline to Azure
     - I chose skip authentication setup (for manually configured pipelines or existing set up)
 - Choose an agent queue for the pipeline - I used Default

At the end it will ask "Would you like to commit and push your local changes to start the configured CI pipeline?" - say yes if you want to push and run the pipeline immediately.

On first attempt this failed with error

> A task is missing. The pipeline references a task called 'setup-azd'. This usually indicates the task isn't installed, and you may be able to install it from the Marketplace: https://marketplace.visualstudio.com. (Task version 1, job 'Job', step ''.)

The fix is to install the task - go to your organisation settings, select extensions, brows the marketplace and install. The extension is here - , [Install azd - Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=ms-azuretools.azd)

The second issue was a missing service connection. I added an Azure Resource manager service connection called `azconnection`. It's possible that I was logged into the wrong subscription when I ran the `azd pipeline` command above or that I was wrong to skip the authentication step. Your mileage may vary.

Next issue:

> ERROR: deployment failed: initializing provisioning manager: resolving bicep parameters file: fetching current principal id: getting subscription $(AZURE_SUBSCRIPTION_ID): failed to resolve user '' access to subscription with ID '$(AZURE_SUBSCRIPTION_ID)'. If you recently gained access to this subscription, run `azd auth login` again to reload subscriptions.
> If you have lost access to a tenant containing this subscription, you may need to run `azd auth login --tenant-id <tenant-id>` to re-authenticate to that specific tenant. Otherwise, visit this subscription in Azure Portal using the browser, then run `azd auth login`.

I then checked the service connection and it was pointing at an old resource group. Since no resource group had been created yet, I changed this to "all resource groups".

The pipeline still failed. Suggested fix information:
> The failure is caused by AZURE_SUBSCRIPTION_ID being passed literally as:
> $(AZURE_SUBSCRIPTION_ID)
> Azure Pipelines did not resolve that variable, and azd therefore tried to find a subscription with that literal ID.
> Define AZURE_SUBSCRIPTION_ID as a pipeline/variable-group variable, or derive it from the authenticated service connection:
> inlineScript: |
>   export AZURE_SUBSCRIPTION_ID="$(az account show --query id -o tsv)"
>   azd provision --no-prompt
> 
> Alternatively, set it explicitly:
> 
> Also check the other $(...) variables, especially AZURE_LOCATION and AZURE_ENV_NAME; unresolved Azure Pipeline macros can cause similar failures. The workload identity issuer and subject are not the issue because az login --federated-token succeeded.

It's likely that the variables or secrets need to be set. See [Configure advanced features for Azure Pipelines with the Azure Developer CLI | Microsoft Learn](https://learn.microsoft.com/en-us/azure/developer/azure-developer-cli/pipeline-advanced-features).

Keeping the ACR clean - to stop uncontrolled growth of the Azure Container Registry and possible deployment problems if the quota is reached, old images should be purged. In earlydevelopment you might be regularly deleting resources but as you get further qalong you should consider automating cleanup. The likedIn article references below gives a GitHub action:
```
    - name: Purge old images (keep last 5 per repo)
      run: |
        az acr run \
          --registry "${{ vars.AZURE_CONTAINER_REGISTRY_NAME }}" \
          --cmd "acr purge --filter '.*:.*' --untagged --ago 0d --keep 5" \
          /dev/null
```

This can be rewritten as an Azure DevOps task and added to the pieline, or to a separate housekeeping pipeline.


See
- [Pipelines and app topology | Aspire](https://aspire.dev/deployment/pipelines/)
- [CI/CD overview | Aspire](https://aspire.dev/deployment/ci-cd/) - this uses GitHub Actions
- [Explore Azure Developer CLI support for CI/CD pipelines | Microsoft Learn](https://learn.microsoft.com/en-us/azure/developer/azure-developer-cli/configure-devops-pipeline)
    - ADO: [Configure a pipeline using Azure Pipelines | Microsoft Learn](https://learn.microsoft.com/en-us/azure/developer/azure-developer-cli/pipeline-azure-pipelines)
    - GitHub Actions: 
- [Use personal access tokens - Azure DevOps | Microsoft Learn](https://learn.microsoft.com/en-us/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate?view=azure-devops&amp;tabs=Windows#create-a-pat)
- Good article on Azd deployment, with suggestions on cleaning up ACR resources and sharing Redis in Azure - [The Gap Between Local Dev and Azure Is Three Commands Wide. Until It Isn't.](https://www.linkedin.com/pulse/gap-between-local-dev-azure-three-commands-wide-until-kiril-iliev-cpa3f) 
- 

---

## Troubleshooting

### Docker not running

```
error: failed to build image
```

Start Docker Desktop and retry `azd up`.

### Insufficient Azure permissions

Ensure your account has at least **Contributor** role on the target subscription or resource group.

### empty dotnet configuration output

If `azd up` fails with:

```
ERROR: empty dotnet configuration output
Suggestion: Ensure project '...' is enabled for container support
```

Add `<EnableSdkContainerSupport>true</EnableSdkContainerSupport>` to the `.csproj` of any .NET project being deployed as a container:

```xml
<PropertyGroup>
  <EnableSdkContainerSupport>true</EnableSdkContainerSupport>
</PropertyGroup>
```

This is already set in `AspirePy.Web.csproj` but would need adding to any new .NET projects added to the solution.

### azd reports "Skipped: Didn't find new changes" but deployment is outdated

`azd` caches package output and may skip rebuilding even after project file changes. Force a fresh package and deploy:

```powershell
azd package --all
azd deploy --all
```

If services are still not updating, tear down and redeploy from scratch:

```powershell
azd down
azd up
```

### ContainerAppEnvironmentMismatch — Container App already exists in a different environment

```
ContainerAppEnvironmentMismatch: Container App 'web' already exists in a different environment.
```

This happens when `.WithAzdResourceNaming()` is present in `AppHost.cs` alongside `AddAzureContainerAppEnvironment`. The two naming conventions conflict, causing Aspire to try to create the Container App in a different environment from the one Azure already provisioned.

**Fix:** Remove `.WithAzdResourceNaming()` from `AppHost.cs`. It should only be used when migrating an existing deployment that was originally done without `AddAzureContainerAppEnvironment` (limited mode). For fresh deployments it must not be present.

After removing it, delete the conflicting Container App from Azure and redeploy:

```powershell
az containerapp delete --name <app-name> --resource-group <resource-group> --yes
azd up
```

Alternatively, delete the Container App via the Azure Portal before running `azd up`.

### Python container build fails

The Python container is built using `uv`. Ensure `uv.lock` is committed — it is the source of truth for the container dependency install.

### Corporate SSL interception

If you are on a corporate network with TLS interception, see the [SSL certificate setup](../README.md#uv-ssl-configuration-corporate-machines) section in the README before running `azd up`.

### Windows username contains a space

If your Windows username contains a space (e.g. `<user-name>`), `azd` may fail to invoke the Bicep compiler or Docker because it does not quote paths correctly. This produces errors like:

```
'C:\Users\<user-name>' is not recognized as an internal or external command
```

```
open C:\Users\<user-name>\AppData\Local\Temp\azd-docker-build...\imgId: The system cannot find the file specified.
```

**Fix 1 — Temp directory (resolves the Docker error)**

Set `TEMP` and `TMP` to a path without spaces. Add these lines to your PowerShell profile (`notepad $PROFILE`):

```powershell
$env:TEMP = "C:\Temp"
$env:TMP  = "C:\Temp"
```

Create the folder if it doesn't exist:

```powershell
New-Item -ItemType Directory -Path C:\Temp -Force
```

**Fix 2 — Bicep binary path (resolves the Bicep error)**

Option A — Create a directory junction to your user profile (run once in an elevated terminal):

```powershell
# Replace "<user-name>" and "<user-name-no-spaces>" with your actual username
New-Item -ItemType Junction -Path "C:\Users\<user-name-no-spaces>" -Target "C:\Users\<user-name>"
```

If that fails, use `mklink` via `cmd` as an alternative:

```powershell
cmd /c mklink /J "C:\Users\<user-name-no-spaces>" "C:\Users\<user-name>"
```

Then point `azd` at the Bicep binary via the junction:

```powershell
azd config set bicep.path "C:\Users\<user-name-no-spaces>\.azd\bin\bicep.exe"
```

Option B — Install the standalone Bicep CLI to a path with no spaces and point `azd` at it:

```powershell
# Install Bicep to a spaceless path, e.g. C:\tools\
az bicep install --target-platform win-x64 # or download from https://github.com/Azure/bicep/releases
azd config set bicep.path "C:\tools\bicep.exe"
```

**After applying both fixes**, open a new terminal (so the env vars take effect) and retry:

```powershell
azd up
```
