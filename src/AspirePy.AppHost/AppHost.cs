using Google.Protobuf.WellKnownTypes;

var builder = DistributedApplication.CreateBuilder(args);

builder.AddAzureContainerAppEnvironment("env");

var entraTenantId    = builder.AddParameter("entra-tenant-id");
var entraClientId    = builder.AddParameter("entra-client-id");
var entraClientSecret = builder.AddParameter("entra-client-secret", secret: true);
var entraApiClientId = builder.AddParameter("entra-api-client-id");

// Application Insights is only provisioned during publish (azd deploy).
// When running locally no Azure credentials are required.
var python = builder.AddUvicornApp(
        name: "python-app",
        appDirectory: "../pyapp",
        app: "main:app")
    .WithVirtualEnvironment(".venv", createIfNotExists: true)
    .WithUv(args: ["sync", "--allow-insecure-host", "pypi.org", "--allow-insecure-host", "files.pythonhosted.org"])
    .WithEnvironment("ENTRA_TENANT_ID", entraTenantId)
    .WithEnvironment("ENTRA_CLIENT_ID", entraApiClientId)
    .WithHttpHealthCheck(path: "/health");

if (!builder.ExecutionContext.IsPublishMode)
{
    python.WithExternalHttpEndpoints();
}

var web = builder.AddProject<Projects.AspirePy_Web>("web")
    .WithReference(python)
    .WaitFor(python)
    .WithExternalHttpEndpoints()
    .WithEnvironment("AzureAd__TenantId", entraTenantId)
    .WithEnvironment("AzureAd__ClientId", entraClientId)
    .WithEnvironment("AzureAd__ClientSecret", entraClientSecret)
    .WithEnvironment("PythonApi__ClientId", entraApiClientId);

builder.AddViteApp("frontend-react", "../frontend-react")
    .WithNpm()
    .WithReference(python)
    .WaitFor(python);

if (builder.ExecutionContext.IsPublishMode)
{
    var insights = builder.AddAzureApplicationInsights("app-insights");
    python.WithReference(insights);
    web.WithReference(insights);
}

await builder.Build().RunAsync();
