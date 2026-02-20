<?php

namespace App\Service;

use Symfony\Component\HttpClient\HttpClient;
use Symfony\Contracts\HttpClient\Exception\TransportExceptionInterface;
use Symfony\Contracts\HttpClient\HttpClientInterface;

/**
 * Сервис для запросов к OpenAI (через реверс-прокси).
 */
class OpenAiService
{
    private HttpClientInterface $client;

    public function __construct(
        private readonly string $apiKey,
        private readonly string $endpoint,
        private readonly string $model = 'gpt-4o-mini',
    ) {
        $this->client = HttpClient::create(['timeout' => 60]);
    }

    /**
     * Отправить массив сообщений, получить текст ответа.
     *
     * @param array  $messages  [['role'=>'user','content'=>'...'], ...]
     * @param int    $maxTokens
     * @param bool   $jsonMode   Включить response_format: json_object
     */
    public function chat(array $messages, int $maxTokens = 600, bool $jsonMode = false): array
    {
        $payload = [
            'model'      => $this->model,
            'max_tokens' => $maxTokens,
            'messages'   => $messages,
        ];

        if ($jsonMode) {
            $payload['response_format'] = ['type' => 'json_object'];
        }

        try {
            $response = $this->client->request('POST', $this->endpoint, [
                'json'    => $payload,
                'headers' => [
                    'Authorization' => 'Bearer ' . $this->apiKey,
                    'Content-Type'  => 'application/json',
                ],
            ]);

            $data = $response->toArray(false);
            $text = $data['choices'][0]['message']['content'] ?? '';

            return ['ok' => true, 'text' => $text];
        } catch (TransportExceptionInterface $e) {
            return ['ok' => false, 'error' => $e->getMessage()];
        }
    }

    /**
     * Оценить маршрут — вернуть ['score' => int, 'summary' => string].
     */
    public function scoreRoute(int $durationMin, int $distanceM, array $maneuvers): array
    {
        $crossings     = 0;
        $maneuverLines = '';
        $crossingTypes = ['pedestrian_road_crossing', 'crossroad', 'crossroad_left', 'crossroad_right'];

        foreach (array_slice($maneuvers, 0, 20) as $i => $m) {
            $type    = $m['type']    ?? '';
            $comment = $m['comment'] ?? '';
            $dist    = !empty($m['distance']) ? " ({$m['distance']} м)" : '';

            if (in_array($type, $crossingTypes, true)) {
                $crossings++;
            }

            if ($comment && !in_array($comment, ['start', 'finish'], true)) {
                $maneuverLines .= ($i + 1) . ". [{$type}] {$comment}{$dist}\n";
            }
        }

        $prompt = <<<PROMPT
Оцени маршрут по шкале от 1 до 10 с точки зрения удобства и безопасности для человека.

Данные:
- Расстояние: {$distanceM} м
- Время: {$durationMin} мин
- Пересечений дорог / поворотов: {$crossings}

Манёвры:
{$maneuverLines}

Шкала: 9-10 отлично, 7-8 хорошо, 5-6 умеренно, 3-4 сложно, 1-2 очень плохо.

Верни ТОЛЬКО JSON: {"score": <1-10>, "summary": "<3-4 предложения на русском>"}
PROMPT;

        $result = $this->chat(
            messages: [
                ['role' => 'system', 'content' => 'Ты оцениваешь маршруты. Отвечай только валидным JSON.'],
                ['role' => 'user',   'content' => $prompt],
            ],
            maxTokens: 350,
            jsonMode: true,
        );

        if (!$result['ok']) {
            return ['score' => null, 'summary' => 'Ошибка: ' . $result['error']];
        }

        $data = json_decode($result['text'], true);
        if (!is_array($data) || !isset($data['score'])) {
            return ['score' => null, 'summary' => $result['text']];
        }

        return [
            'score'   => max(1, min(10, (int) $data['score'])),
            'summary' => (string) ($data['summary'] ?? ''),
        ];
    }

    /**
     * Анализ скриншота карты через Vision API.
     * Возвращает ['score'=>int, 'traffic_lights'=>int, 'crosswalks'=>int, 'road_type'=>string, 'has_parks'=>bool, 'comment'=>string]
     */
    public function analyzeMapImage(
        string $base64Image,
        int    $durationMin,
        int    $distanceM,
        int    $unsafeCrossings,
        int    $safeCrossings,
    ): array {
        $prompt = <<<PROMPT
Это скриншот пешеходного маршрута на карте 2GIS. Цветная линия на карте — маршрут.

Данные из Routing API:
- Время: {$durationMin} мин, расстояние: {$distanceM} м
- Открытых переходов через дорогу: {$unsafeCrossings}
- Безопасных переходов (мост/тоннель): {$safeCrossings}

Проанализируй карту визуально и верни ТОЛЬКО JSON:
{
  "traffic_lights": <сколько светофоров видно вдоль маршрута, число>,
  "crosswalks": <сколько пешеходных переходов видно, число>,
  "road_type": "магистраль" | "жилая" | "смешанная",
  "has_parks": <true если маршрут проходит через парк или сквер>,
  "score": <итоговая оценка 1-10 с учётом и карты и данных API>,
  "comment": "<2-3 предложения на русском: что видно на карте, почему такая оценка>"
}
PROMPT;

        $result = $this->chat(
            messages: [[
                'role'    => 'user',
                'content' => [
                    ['type' => 'text',      'text'      => $prompt],
                    ['type' => 'image_url', 'image_url' => ['url' => "data:image/jpeg;base64,{$base64Image}"]],
                ],
            ]],
            maxTokens: 500,
            jsonMode:  false,
        );

        if (!$result['ok']) {
            return ['error' => $result['error']];
        }

        // Extract JSON from response text (might have markdown fences)
        $text = $result['text'];
        if (preg_match('/\{.*\}/s', $text, $m)) {
            $data = json_decode($m[0], true);
        }

        if (empty($data) || !isset($data['score'])) {
            return ['error' => 'Не удалось разобрать ответ', 'raw' => $text];
        }

        return [
            'score'          => max(1, min(10, (int) $data['score'])),
            'traffic_lights' => (int)    ($data['traffic_lights'] ?? 0),
            'crosswalks'     => (int)    ($data['crosswalks']     ?? 0),
            'road_type'      => (string) ($data['road_type']      ?? ''),
            'has_parks'      => (bool)   ($data['has_parks']      ?? false),
            'comment'        => (string) ($data['comment']        ?? ''),
        ];
    }
}
