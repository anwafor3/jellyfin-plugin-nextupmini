using System;
using System.IO;

namespace Jellyfin.Plugin.NextUpMini.Injection;

/// <summary>
/// Fallback for servers without the File Transformation plugin: edits the web player's
/// index.html on disk. This only works when Jellyfin can write to its web folder, and a
/// Jellyfin update replaces the file, so the tag is re-added at every server start.
/// </summary>
public static class IndexHtmlPatcher
{
    /// <summary>
    /// Adds the script tag to index.html on disk.
    /// </summary>
    /// <param name="webPath">Jellyfin's web folder.</param>
    /// <param name="message">What happened, for the log.</param>
    /// <returns>True if the tag is in place afterwards.</returns>
    public static bool TryApply(string? webPath, out string message)
    {
        var file = GetIndexPath(webPath);
        if (file is null)
        {
            message = "web folder not found";
            return false;
        }

        try
        {
            var html = File.ReadAllText(file);
            if (html.Contains(ScriptProvider.ScriptMarker, StringComparison.Ordinal))
            {
                message = "already present in " + file;
                return true;
            }

            var updated = ScriptProvider.InjectTag(html);
            if (ReferenceEquals(updated, html) || updated == html)
            {
                message = "no </body> tag in " + file;
                return false;
            }

            File.WriteAllText(file, updated);
            message = "added to " + file;
            return true;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            message = "cannot write " + file + " (" + ex.Message + ")";
            return false;
        }
    }

    /// <summary>
    /// Removes the script tag from index.html on disk, if present.
    /// </summary>
    /// <param name="webPath">Jellyfin's web folder.</param>
    /// <param name="message">What happened, for the log.</param>
    /// <returns>True if the file no longer contains the tag.</returns>
    public static bool TryRemove(string? webPath, out string message)
    {
        var file = GetIndexPath(webPath);
        if (file is null)
        {
            message = "web folder not found";
            return true;
        }

        try
        {
            var html = File.ReadAllText(file);
            if (!html.Contains(ScriptProvider.ScriptTag, StringComparison.Ordinal))
            {
                message = "nothing to remove";
                return true;
            }

            File.WriteAllText(file, html.Replace(ScriptProvider.ScriptTag, string.Empty, StringComparison.Ordinal));
            message = "removed from " + file;
            return true;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            message = "cannot write " + file + " (" + ex.Message + ")";
            return false;
        }
    }

    private static string? GetIndexPath(string? webPath)
    {
        if (string.IsNullOrEmpty(webPath))
        {
            return null;
        }

        var file = Path.Combine(webPath, "index.html");
        return File.Exists(file) ? file : null;
    }
}
