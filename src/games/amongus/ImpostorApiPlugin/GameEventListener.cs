using System;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using Impostor.Api.Events;
using Impostor.Api.Events.Player;
using Impostor.Api.Innersloth;
using Microsoft.Extensions.Logging;

namespace ImpostorApiPlugin
{
    /// <summary>
    /// Listens to in-game events and pushes them to the NexKord Discord bot
    /// so it can enforce voice rules (e.g. push-to-talk for dead players).
    /// </summary>
    public class GameEventListener : IEventListener
    {
        private static readonly HttpClient HttpClient = new HttpClient
        {
            Timeout = TimeSpan.FromSeconds(3)
        };

        private readonly ILogger _logger;
        private readonly string _botEventUrl;
        private readonly string _apiKey;

        /// <summary>
        /// Initializes a new instance of the GameEventListener class.
        /// </summary>
        /// <param name="logger">Logger for diagnostics</param>
        public GameEventListener(ILogger logger)
        {
            _logger = logger;
            _botEventUrl = Environment.GetEnvironmentVariable("BOT_EVENT_URL")
                ?? "http://nexkord-adm:22026/events";
            _apiKey = Environment.GetEnvironmentVariable("IMPOSTOR_API_KEY")
                ?? "your_secret_key";
        }

        [EventListener]
        public void OnGameStarted(IGameStartedEvent e)
        {
            PostEvent("game_start", e.Game.Code.Code, null);
        }

        [EventListener]
        public void OnPlayerMurder(IPlayerMurderEvent e)
        {
            if ((e.Result & (MurderResultFlags.FailedError | MurderResultFlags.FailedProtected)) != 0)
            {
                return;
            }
            PostEvent("kill", e.Game.Code.Code, e.Victim?.PlayerInfo?.PlayerName);
        }

        [EventListener]
        public void OnPlayerExile(IPlayerExileEvent e)
        {
            PostEvent("exile", e.Game.Code.Code, e.PlayerControl?.PlayerInfo?.PlayerName);
        }

        [EventListener]
        public void OnPlayerLeft(IGamePlayerLeftEvent e)
        {
            PostEvent("leave", e.Game.Code.Code, e.Player?.Character?.PlayerInfo?.PlayerName);
        }

        [EventListener]
        public void OnGameEnded(IGameEndedEvent e)
        {
            PostEvent("game_end", e.Game.Code.Code, null);
        }

        [EventListener]
        public void OnGameDestroyed(IGameDestroyedEvent e)
        {
            PostEvent("game_end", e.Game.Code.Code, null);
        }

        /// <summary>
        /// Fire-and-forget POST of an event to the bot. Never blocks the game thread
        /// and never throws into the event pipeline.
        /// </summary>
        private void PostEvent(string type, string gameCode, string playerName)
        {
            _ = Task.Run(async () =>
            {
                try
                {
                    var payload = JsonSerializer.Serialize(new
                    {
                        type,
                        gameCode,
                        playerName,
                    });

                    using var request = new HttpRequestMessage(HttpMethod.Post, _botEventUrl)
                    {
                        Content = new StringContent(payload, Encoding.UTF8, "application/json"),
                    };
                    request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _apiKey);

                    await HttpClient.SendAsync(request);
                }
                catch (Exception ex)
                {
                    _logger.LogWarning("Failed to push '{Type}' event to bot: {Message}", type, ex.Message);
                }
            });
        }
    }
}
