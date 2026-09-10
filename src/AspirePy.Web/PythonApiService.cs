using System.Net.Http.Headers;
using Microsoft.Identity.Web;

namespace AspirePy.Web;

public class PythonApiService(
    IHttpClientFactory httpClientFactory,
    ITokenAcquisition tokenAcquisition,
    IConfiguration configuration)
{
    private string Scope =>
        $"api://{configuration["PythonApi:ClientId"]}/access_as_user";

    public async Task<string?> GetGreetingAsync(string name)
    {
        var client = httpClientFactory.CreateClient("python-app");
        var token = await tokenAcquisition.GetAccessTokenForUserAsync([Scope]);
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);

        var response = await client.GetFromJsonAsync<HelloResponse>(
            $"/hello/{Uri.EscapeDataString(name.Trim())}");
        return response?.Message;
    }

    private record HelloResponse(string Message);
}
