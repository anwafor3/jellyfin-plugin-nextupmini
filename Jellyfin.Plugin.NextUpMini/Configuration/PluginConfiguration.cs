using MediaBrowser.Model.Plugins;

namespace Jellyfin.Plugin.NextUpMini.Configuration;

/// <summary>
/// Settings shown on the plugin's Dashboard page.
/// </summary>
public class PluginConfiguration : BasePluginConfiguration
{
    /// <summary>Gets or sets a value indicating whether the overlay is turned on.</summary>
    public bool Enabled { get; set; } = true;

    /// <summary>Gets or sets the countdown length in seconds before the next episode starts.</summary>
    public int CountdownSeconds { get; set; } = 10;

    /// <summary>
    /// Gets or sets how many seconds before the end to show the overlay when an episode has
    /// no credits marker. 0 turns the fallback off.
    /// </summary>
    public int FallbackSeconds { get; set; } = 30;

    /// <summary>Gets or sets a value indicating whether chapters named like "Credits" count as a credits marker.</summary>
    public bool UseChapterMarkers { get; set; } = true;

    /// <summary>
    /// Gets or sets a value indicating whether a gap between the end of the credits marker and the end
    /// of the episode is treated as a scene after the credits (no countdown, "Skip to scene" button).
    /// Off by default: it relies on credits markers that cover the whole credits.
    /// </summary>
    public bool DetectPostCreditsScenes { get; set; }

    /// <summary>Gets or sets the mini player's width as a percentage of the screen width.</summary>
    public int MiniPlayerWidthPercent { get; set; } = 28;

    /// <summary>Gets or sets the corner for the mini player: "BottomRight" or "BottomLeft".</summary>
    public string Corner { get; set; } = "BottomRight";

    /// <summary>Gets or sets a value indicating whether Jellyfin's own "Next Episode" card is hidden while the overlay shows.</summary>
    public bool HideBuiltInUpNext { get; set; } = true;
}
