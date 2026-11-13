using System;
using System.Reflection;

namespace Jellyfin.Plugin.NextUpMini.Injection;

/// <summary>
/// Called by the File Transformation plugin whenever Jellyfin serves index.html.
/// It changes the file in memory only, so nothing on disk is touched.
/// </summary>
public static class FileTransformationCallbacks
{
    /// <summary>
    /// Adds the Next Up Mini script tag to index.html.
    /// </summary>
    /// <param name="payload">File Transformation's request object; its "contents" holds the file text.</param>
    /// <returns>The updated file text.</returns>
    public static string TransformIndexHtml(object payload)
    {
        return ScriptProvider.InjectTag(ReadContents(payload));
    }

    /// <summary>
    /// Reads the file text from File Transformation's payload without referencing its types,
    /// since each Jellyfin plugin is loaded separately.
    /// </summary>
    /// <param name="payload">The payload object.</param>
    /// <returns>The file text, or an empty string if it cannot be read.</returns>
    internal static string ReadContents(object? payload)
    {
        switch (payload)
        {
            case null:
                return string.Empty;
            case string text:
                return text;
        }

        var type = payload.GetType();

        // A plain object with a Contents property.
        var property = type.GetProperty("Contents", BindingFlags.Public | BindingFlags.Instance | BindingFlags.IgnoreCase);
        if (property is not null && property.GetIndexParameters().Length == 0)
        {
            return property.GetValue(payload)?.ToString() ?? string.Empty;
        }

        // A JSON object with a string indexer, such as Newtonsoft's JObject.
        var indexer = type.GetProperty("Item", new[] { typeof(string) });
        if (indexer is not null)
        {
            foreach (var key in new[] { "contents", "Contents" })
            {
                var value = indexer.GetValue(payload, new object[] { key });
                if (value is not null)
                {
                    return value.ToString() ?? string.Empty;
                }
            }
        }

        return string.Empty;
    }
}
