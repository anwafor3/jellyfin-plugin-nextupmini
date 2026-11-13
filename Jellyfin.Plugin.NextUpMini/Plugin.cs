using System;
using System.Collections.Generic;
using System.Globalization;
using Jellyfin.Plugin.NextUpMini.Configuration;
using Jellyfin.Plugin.NextUpMini.Injection;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;

namespace Jellyfin.Plugin.NextUpMini;

/// <summary>
/// Next Up Mini: shrinks end credits into a corner of the web player and counts down to the next episode.
/// </summary>
public class Plugin : BasePlugin<PluginConfiguration>, IHasWebPages
{
    /// <summary>The plugin's unique ID. Never change this after the first release.</summary>
    public const string PluginGuid = "c700d2b1-f78b-4b75-90a6-ce74245ac3fb";

    /// <summary>
    /// Initializes a new instance of the <see cref="Plugin"/> class.
    /// </summary>
    /// <param name="applicationPaths">Jellyfin's application paths.</param>
    /// <param name="xmlSerializer">Jellyfin's XML serializer, used for the settings file.</param>
    public Plugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer)
        : base(applicationPaths, xmlSerializer)
    {
        Instance = this;
    }

    /// <summary>Gets the running plugin instance.</summary>
    public static Plugin? Instance { get; private set; }

    /// <inheritdoc />
    public override string Name => "Next Up Mini";

    /// <inheritdoc />
    public override Guid Id => Guid.Parse(PluginGuid);

    /// <inheritdoc />
    public override string Description =>
        "Shrinks end credits into a corner of the web player and counts down to the next episode.";

    /// <inheritdoc />
    public IEnumerable<PluginPageInfo> GetPages()
    {
        return new[]
        {
            new PluginPageInfo
            {
                Name = Name,
                EmbeddedResourcePath = string.Format(
                    CultureInfo.InvariantCulture,
                    "{0}.Configuration.configPage.html",
                    GetType().Namespace)
            }
        };
    }

    /// <inheritdoc />
    public override void OnUninstalling()
    {
        // Undo the on-disk fallback, if it was used, so no dead script tag is left behind.
        IndexHtmlPatcher.TryRemove(ApplicationPaths.WebPath, out _);
        base.OnUninstalling();
    }
}
