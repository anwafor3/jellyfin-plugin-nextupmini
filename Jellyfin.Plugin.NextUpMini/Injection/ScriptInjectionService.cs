using System;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Common.Configuration;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.NextUpMini.Injection;

/// <summary>
/// At server start, makes the web player load the Next Up Mini script.
/// Prefers the File Transformation plugin (in-memory, survives updates, works in Docker);
/// otherwise edits index.html on disk.
/// </summary>
public sealed class ScriptInjectionService : IHostedService
{
    private const string FileTransformationType = "Jellyfin.Plugin.FileTransformation.PluginInterface";

    private readonly ILogger<ScriptInjectionService> _logger;
    private readonly IApplicationPaths _applicationPaths;

    /// <summary>
    /// Initializes a new instance of the <see cref="ScriptInjectionService"/> class.
    /// </summary>
    /// <param name="logger">The logger.</param>
    /// <param name="applicationPaths">Jellyfin's application paths.</param>
    public ScriptInjectionService(ILogger<ScriptInjectionService> logger, IApplicationPaths applicationPaths)
    {
        _logger = logger;
        _applicationPaths = applicationPaths;
    }

    /// <inheritdoc />
    public Task StartAsync(CancellationToken cancellationToken)
    {
        if (TryRegisterWithFileTransformation())
        {
            _logger.LogInformation("Next Up Mini: script added through the File Transformation plugin");

            // Clean up an on-disk tag from an earlier fallback run so it isn't added twice.
            IndexHtmlPatcher.TryRemove(_applicationPaths.WebPath, out _);
            return Task.CompletedTask;
        }

        if (IndexHtmlPatcher.TryApply(_applicationPaths.WebPath, out var message))
        {
            _logger.LogInformation("Next Up Mini: script tag {Message}", message);
        }
        else
        {
            _logger.LogWarning(
                "Next Up Mini: could not add the script ({Message}). Install the File Transformation plugin to fix this.",
                message);
        }

        return Task.CompletedTask;
    }

    /// <inheritdoc />
    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    private bool TryRegisterWithFileTransformation()
    {
        try
        {
            // Plugins are loaded in separate contexts, so find File Transformation by name, not by reference.
            var pluginInterface = AssemblyLoadContext.All
                .SelectMany(context => context.Assemblies)
                .Where(assembly => assembly.FullName?.Contains(".FileTransformation", StringComparison.Ordinal) == true)
                .Select(assembly => assembly.GetType(FileTransformationType))
                .FirstOrDefault(type => type is not null);

            var register = pluginInterface?.GetMethod("RegisterTransformation", BindingFlags.Public | BindingFlags.Static);
            if (register is null || register.GetParameters().Length != 1)
            {
                _logger.LogInformation("Next Up Mini: File Transformation plugin not found; using the on-disk fallback");
                return false;
            }

            var json = JsonSerializer.Serialize(new
            {
                id = Plugin.PluginGuid,
                fileNamePattern = "index.html",
                callbackAssembly = typeof(FileTransformationCallbacks).Assembly.FullName,
                callbackClass = typeof(FileTransformationCallbacks).FullName,
                callbackMethod = nameof(FileTransformationCallbacks.TransformIndexHtml)
            });

            var argument = CreateArgument(register.GetParameters()[0].ParameterType, json);
            if (argument is null)
            {
                _logger.LogWarning(
                    "Next Up Mini: unsupported File Transformation version ({Type}); using the on-disk fallback",
                    register.GetParameters()[0].ParameterType.FullName);
                return false;
            }

            register.Invoke(null, new[] { argument });
            return true;
        }
        catch (Exception ex) when (ex is TargetInvocationException or ArgumentException or InvalidOperationException or MemberAccessException)
        {
            _logger.LogWarning(ex, "Next Up Mini: File Transformation registration failed; using the on-disk fallback");
            return false;
        }
    }

    /// <summary>
    /// Builds the registration payload as whatever JSON type File Transformation expects
    /// (for example Newtonsoft's JObject), using that type's own Parse method so the
    /// object comes from File Transformation's copy of the library.
    /// </summary>
    private static object? CreateArgument(Type parameterType, string json)
    {
        if (parameterType == typeof(string))
        {
            return json;
        }

        var parse = parameterType
            .GetMethods(BindingFlags.Public | BindingFlags.Static)
            .Where(method => method.Name == "Parse")
            .Select(method => new { Method = method, Parameters = method.GetParameters() })
            .Where(candidate => candidate.Parameters.Length > 0
                && candidate.Parameters[0].ParameterType == typeof(string)
                && candidate.Parameters.Skip(1).All(parameter => parameter.IsOptional)
                && parameterType.IsAssignableFrom(candidate.Method.ReturnType))
            .OrderBy(candidate => candidate.Parameters.Length)
            .FirstOrDefault();

        if (parse is null)
        {
            return null;
        }

        var arguments = new object?[parse.Parameters.Length];
        arguments[0] = json;
        for (var i = 1; i < arguments.Length; i++)
        {
            arguments[i] = parse.Parameters[i].DefaultValue;
        }

        return parse.Method.Invoke(null, arguments);
    }
}
