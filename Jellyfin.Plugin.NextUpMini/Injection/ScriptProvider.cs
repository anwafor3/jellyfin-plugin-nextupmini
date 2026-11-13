using System;
using System.IO;
using System.Text.Json;
using Jellyfin.Plugin.NextUpMini.Configuration;

namespace Jellyfin.Plugin.NextUpMini.Injection;

/// <summary>
/// Builds the web script and the script tag that loads it.
/// </summary>
public static class ScriptProvider
{
    /// <summary>
    /// The tag added to the web player's index.html. The path is relative to /web/,
    /// so it also works when Jellyfin runs under a base URL such as /jellyfin.
    /// </summary>
    public const string ScriptTag = "<script defer data-next-up-mini src=\"../NextUpMini/script.js\"></script>";

    /// <summary>Text that identifies our tag inside index.html.</summary>
    public const string ScriptMarker = "data-next-up-mini";

    private const string ConfigPlaceholder = "/*NUM_CONFIG*/{}";

    private static readonly Lazy<string> Template = new(LoadTemplate);

    /// <summary>
    /// Returns the web script with the given settings built in.
    /// </summary>
    /// <param name="config">The plugin settings.</param>
    /// <returns>JavaScript source.</returns>
    public static string Build(PluginConfiguration config)
    {
        ArgumentNullException.ThrowIfNull(config);

        var settings = new
        {
            enabled = config.Enabled,
            countdown = Math.Clamp(config.CountdownSeconds, 3, 60),
            fallback = Math.Clamp(config.FallbackSeconds, 0, 300),
            chapters = config.UseChapterMarkers,
            postCredits = config.DetectPostCreditsScenes,
            width = Math.Clamp(config.MiniPlayerWidthPercent, 15, 45),
            corner = string.Equals(config.Corner, "BottomLeft", StringComparison.OrdinalIgnoreCase) ? "left" : "right",
            hideBuiltIn = config.HideBuiltInUpNext
        };

        return Template.Value.Replace(ConfigPlaceholder, JsonSerializer.Serialize(settings), StringComparison.Ordinal);
    }

    /// <summary>
    /// Adds the script tag before the closing body tag, unless it is already there.
    /// </summary>
    /// <param name="html">The contents of index.html.</param>
    /// <returns>The updated HTML, or the original if no change was needed or possible.</returns>
    public static string InjectTag(string html)
    {
        if (string.IsNullOrEmpty(html) || html.Contains(ScriptMarker, StringComparison.Ordinal))
        {
            return html;
        }

        var bodyEnd = html.LastIndexOf("</body>", StringComparison.OrdinalIgnoreCase);
        return bodyEnd < 0 ? html : html.Insert(bodyEnd, ScriptTag);
    }

    private static string LoadTemplate()
    {
        var assembly = typeof(ScriptProvider).Assembly;
        var name = typeof(ScriptProvider).Namespace!.Replace(".Injection", ".Web.next-up-mini.js", StringComparison.Ordinal);
        using var stream = assembly.GetManifestResourceStream(name)
            ?? throw new InvalidOperationException("Embedded script not found: " + name);
        using var reader = new StreamReader(stream);
        return reader.ReadToEnd();
    }
}
