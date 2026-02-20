<?php

namespace App\Service;

use Symfony\Component\HttpClient\HttpClient;
use Symfony\Contracts\HttpClient\Exception\TransportExceptionInterface;
use Symfony\Contracts\HttpClient\HttpClientInterface;

/**
 * Сервис для всех запросов к 2GIS API.
 * Ключ и прокси настраиваются через .env.
 */
class TwogisApiService
{
    private HttpClientInterface $client;

    public function __construct(
        private readonly string $apiKey,
        private readonly string $routingUrl,
        private readonly string $catalogUrl,
        private readonly string $suggestUrl,
        private readonly string $socks5Proxy = '',
    ) {
        $options = ['timeout' => 15];

        if ($socks5Proxy !== '') {
            $options['proxy'] = $socks5Proxy;
            $options['verify_peer'] = false;
        }

        $this->client = HttpClient::create($options);
    }

    // ── Routing ───────────────────────────────────────────────────

    /**
     * Построить маршрут.
     *
     * @param array $points  [['lon'=>..., 'lat'=>..., 'type'=>'stop'], ...]
     * @param string $transport  'walking' | 'driving' | 'bicycle' | ...
     */
    public function buildRoute(array $points, string $transport = 'walking'): array
    {
        $body = [
            'points'    => $points,
            'transport' => $transport,
            'locale'    => 'ru',
            'params'    => ['pedestrian' => ['use_instructions' => true]],
        ];

        return $this->post($this->routingUrl, $body);
    }

    // ── Catalog ───────────────────────────────────────────────────

    /**
     * Поиск объектов в каталоге 2GIS.
     *
     * @param array $params  GET-параметры (q, point, radius, type, fields, ...)
     */
    public function searchCatalog(array $params): array
    {
        return $this->get($this->catalogUrl . '/3.0/items', $params);
    }

    /**
     * Поиск рубрик (категорий) в каталоге.
     */
    public function searchRubric(array $params): array
    {
        return $this->get($this->catalogUrl . '/2.0/catalog/rubric/search', $params);
    }

    /**
     * Поиск региона по названию города.
     */
    public function searchRegion(string $query): array
    {
        return $this->get($this->catalogUrl . '/2.0/region/search', ['q' => $query]);
    }

    /**
     * Обратное геокодирование координат.
     */
    public function geocode(float $lon, float $lat, array $extra = []): array
    {
        return $this->get($this->catalogUrl . '/3.0/items/geocode', array_merge(
            ['lon' => $lon, 'lat' => $lat],
            $extra,
        ));
    }

    /**
     * Автодополнение адресов.
     */
    public function suggest(string $query, array $extra = []): array
    {
        return $this->get($this->suggestUrl, array_merge(['q' => $query], $extra));
    }

    /**
     * Проверить наличие светофора у пешеходного перехода.
     *
     * @param float $lon  долгота точки перехода
     * @param float $lat  широта точки перехода
     * @param int   $radiusM  радиус поиска в метрах
     */
    public function hasTrafficLight(float $lon, float $lat, int $radiusM = 50): bool
    {
        $data  = $this->searchCatalog([
            'q'      => 'светофор',
            'point'  => "{$lon},{$lat}",
            'radius' => $radiusM,
            'sort'   => 'distance',
            'fields' => 'items.point',
        ]);

        return ($data['result']['total'] ?? 0) > 0;
    }

    // ── HTTP helpers ──────────────────────────────────────────────

    private function get(string $url, array $params = []): array
    {
        $params['key'] = $this->apiKey;

        try {
            $response = $this->client->request('GET', $url, ['query' => $params]);
            return $response->toArray(false);
        } catch (TransportExceptionInterface $e) {
            return ['_error' => $e->getMessage()];
        }
    }

    private function post(string $url, array $body): array
    {
        try {
            $response = $this->client->request('POST', $url, [
                'query'   => ['key' => $this->apiKey],
                'json'    => $body,
                'headers' => ['Accept' => 'application/json'],
            ]);
            return $response->toArray(false);
        } catch (TransportExceptionInterface $e) {
            return ['_error' => $e->getMessage()];
        }
    }
}
