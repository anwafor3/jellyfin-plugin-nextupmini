using System.Text;
using Jellyfin.Plugin.NextUpMini.Configuration;
using Jellyfin.Plugin.NextUpMini.Injection;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.NextUpMini.Api;

/// <summary>
/// Serves the web player script, with the current settings built in.
/// </summary>
[ApiController]
[Route("NextUpMini")]
public class NextUpMiniController : ControllerBase
{
    /// <summary>
    /// Gets the Next Up Mini web script.
    /// </summary>
    /// <returns>The JavaScript file.</returns>
    /// <response code="200">Script returned.</response>
    [HttpGet("script.js")]
    [AllowAnonymous] // Loaded by a plain script tag before sign-in; contains no private data.
    [ProducesResponseType(StatusCodes.Status200OK)]
    public ActionResult GetScript()
    {
        var config = Plugin.Instance?.Configuration ?? new PluginConfiguration();
        Response.Headers.CacheControl = "no-cache";
        return Content(ScriptProvider.Build(config), "application/javascript", Encoding.UTF8);
    }
}
