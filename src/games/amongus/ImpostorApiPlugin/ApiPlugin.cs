using System;
using System.IO;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using Impostor.Api.Plugins;
using Impostor.Api.Events.Managers;
using Microsoft.Extensions.Logging;
using Impostor.Api.Games.Managers;
using Impostor.Api.Innersloth;
using Impostor.Api.Innersloth.GameOptions;

namespace ImpostorApiPlugin
{
    /// <summary>
    /// NexKord API Plugin for Impostor Server.
    /// Provides HTTP REST API endpoints for programmatic lobby creation.
    /// </summary>
    [ImpostorPlugin(id: "com.nexkord.apiplugin")]
    public class ApiPlugin : PluginBase
    {
        private readonly ILogger<ApiPlugin> _logger;
        private readonly IGameManager _gameManager;
        private HttpListener _listener;
        private bool _isRunning;

        /// <summary>
        /// Initializes a new instance of the ApiPlugin class.
        /// </summary>
        /// <param name="logger">Logger instance for diagnostic output</param>
        /// <param name="eventManager">Event manager for Impostor server events</param>
        /// <param name="gameManager">Game manager for creating and managing lobbies</param>
        public ApiPlugin(ILogger<ApiPlugin> logger, IEventManager eventManager, IGameManager gameManager)
        {
            _logger = logger;
            _gameManager = gameManager;
        }

        /// <summary>
        /// Enables the plugin and starts the HTTP listener on port 22025.
        /// </summary>
        /// <returns>A ValueTask representing the asynchronous operation</returns>
        public override ValueTask EnableAsync()
        {
            _logger.LogInformation("NexKord API Plugin is enabled.");
            _isRunning = true;
            _listener = new HttpListener();
            _listener.Prefixes.Add("http://*:22025/api/lobby/create/");
            _listener.Start();
            Task.Run(ListenAsync);
            return default;
        }

        /// <summary>
        /// Disables the plugin and stops the HTTP listener.
        /// </summary>
        /// <returns>A ValueTask representing the asynchronous operation</returns>
        public override ValueTask DisableAsync()
        {
            _logger.LogInformation("NexKord API Plugin is disabled.");
            _isRunning = false;
            _listener?.Stop();
            return default;
        }

        /// <summary>
        /// Continuously listens for incoming HTTP requests.
        /// </summary>
        /// <returns>A Task representing the asynchronous operation</returns>
        private async Task ListenAsync()
        {
            while (_isRunning)
            {
                try
                {
                    var context = await _listener.GetContextAsync();
                    _ = Task.Run(() => HandleRequestAsync(context));
                }
                catch (Exception ex) when (_isRunning)
                {
                    _logger.LogError(ex, "Error accepting HTTP request");
                }
            }
        }

        /// <summary>
        /// Handles individual HTTP requests for lobby creation.
        /// </summary>
        /// <param name="context">The HTTP listener context containing request and response</param>
        /// <returns>A Task representing the asynchronous operation</returns>
        private async Task HandleRequestAsync(HttpListenerContext context)
        {
            try
            {
                if (context.Request.HttpMethod == "POST")
                {
                    using var reader = new StreamReader(context.Request.InputStream, context.Request.ContentEncoding);
                    var body = await reader.ReadToEndAsync();
                    var request = JsonSerializer.Deserialize<CreateLobbyRequest>(body, new JsonSerializerOptions { PropertyNameCaseInsensitive = true });

                    var options = new NormalGameOptions(7);
                    options.MaxPlayers = request?.MaxPlayers > 0 ? request.MaxPlayers : (byte)15;
                    options.NumImpostors = request?.ImpostorCount > 0 ? request.ImpostorCount : (byte)2;
                    options.Map = (MapTypes)(request?.MapId ?? 0);

                    var game = await _gameManager.CreateAsync(options, new Impostor.Api.Innersloth.GameFilterOptions());

                    var responseObj = new { roomCode = game.Code.Code };
                    var responseJson = JsonSerializer.Serialize(responseObj);
                    var buffer = Encoding.UTF8.GetBytes(responseJson);

                    context.Response.ContentType = "application/json";
                    context.Response.ContentLength64 = buffer.Length;
                    await context.Response.OutputStream.WriteAsync(buffer, 0, buffer.Length);
                }
                else
                {
                    context.Response.StatusCode = 405;
                }
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error handling request");
                context.Response.StatusCode = 500;
            }
            finally
            {
                context.Response.Close();
            }
        }
    }

    /// <summary>
    /// Request model for lobby creation API endpoint.
    /// </summary>
    public class CreateLobbyRequest
    {
        /// <summary>
        /// Maximum number of players allowed in the lobby (1-15).
        /// </summary>
        public byte MaxPlayers { get; set; }

        /// <summary>
        /// Number of impostors in the game (1-3).
        /// </summary>
        public byte ImpostorCount { get; set; }

        /// <summary>
        /// Map ID: 0 = The Skeld, 1 = Mira HQ, 2 = Polus, 3 = Airship, 4 = The Fungle.
        /// </summary>
        public byte MapId { get; set; }
    }
}
