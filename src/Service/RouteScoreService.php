<?php

namespace App\Service;

/**
 * Калькулятор оценки пешеходного маршрута на основе данных 2GIS Routing API.
 *
 * Формула: SCORE = path_quality * 0.65 + turn_simplicity * 0.35
 *
 * path_quality   — взвешенная средняя по типам покрытия (park_path, living_zone, normal и т.д.)
 * turn_simplicity — насколько прямой маршрут (штраф за острые повороты)
 */
class RouteScoreService
{
    /** Веса комфортности по типу покрытия из geometry[].style */
    private const STYLE_WEIGHTS = [
        'park_path'     => 1.0,
        'living_zone'   => 0.9,
        'undergroundway'=> 0.8,
        'archway'       => 0.7,
        'normal'        => 0.5,
        'crosswalk'     => 0.2,
    ];

    private const STYLE_LABELS = [
        'park_path'     => 'Парк / бульвар',
        'living_zone'   => 'Жилая зона',
        'undergroundway'=> 'Подземный переход',
        'archway'       => 'Арка / проход',
        'normal'        => 'Тротуар',
        'crosswalk'     => 'Пешеходный переход',
    ];

    /**
     * Рассчитать оценку маршрута.
     *
     * @param array $route  Элемент result[0] из ответа 2GIS Routing API
     * @return array{
     *   score: float,
     *   path_quality: float,
     *   turn_simplicity: float,
     *   breakdown: array
     * }
     */
    public function score(array $route): array
    {
        $maneuvers = $route['maneuvers'] ?? [];

        $styleMeters  = [];   // метры по каждому стилю покрытия
        $turnAngles   = [];   // углы поворотов на перекрёстках
        $turnDirs     = [];   // счётчик направлений поворотов
        $roadCrossings = 0;   // количество пересечений дороги

        foreach ($maneuvers as $maneuver) {
            $type = $maneuver['type'] ?? '';

            if ($type === 'pedestrian_road_crossing') {
                $roadCrossings++;
            }

            // Повороты на перекрёстках (не считаем пересечения дорог)
            if ($type === 'pedestrian_crossroad' && isset($maneuver['turn_angle'])) {
                $turnAngles[] = abs($maneuver['turn_angle']);
            }

            // Направления поворотов
            if (isset($maneuver['turn_direction'])) {
                $dir = $maneuver['turn_direction'];
                $turnDirs[$dir] = ($turnDirs[$dir] ?? 0) + 1;
            }

            // Метры по типу покрытия из geometry
            foreach ($maneuver['outcoming_path']['geometry'] ?? [] as $geo) {
                $style  = $geo['style']  ?? 'normal';
                $length = $geo['length'] ?? 0;
                $styleMeters[$style] = ($styleMeters[$style] ?? 0) + $length;
            }
        }

        // ── Path quality ──────────────────────────────────────────────
        $totalMeters = array_sum($styleMeters);
        $weightedSum = 0.0;

        foreach ($styleMeters as $style => $meters) {
            $weight       = self::STYLE_WEIGHTS[$style] ?? 0.5;
            $weightedSum += $meters * $weight;
        }

        $pathQuality = $totalMeters > 0 ? $weightedSum / $totalMeters : 0.5;

        // ── Turn simplicity ───────────────────────────────────────────
        // 1 − средний нормализованный угол поворота (0° = 1.0, 180° = 0.0)
        $turnSimplicity = 1.0;
        if (count($turnAngles) > 0) {
            $avgAngle       = array_sum($turnAngles) / count($turnAngles);
            $turnSimplicity = 1.0 - ($avgAngle / 180.0);
        }

        // ── Итоговый балл ─────────────────────────────────────────────
        $score = round(($pathQuality * 0.65 + $turnSimplicity * 0.35) * 10, 1);

        // ── Разбивка по зонам (сортировка по убыванию метров) ────────
        arsort($styleMeters);
        $zones = [];
        foreach ($styleMeters as $style => $meters) {
            $zones[$style] = [
                'label'   => self::STYLE_LABELS[$style] ?? $style,
                'meters'  => (int) round($meters),
                'percent' => $totalMeters > 0 ? (int) round($meters / $totalMeters * 100) : 0,
                'weight'  => self::STYLE_WEIGHTS[$style] ?? 0.5,
            ];
        }

        // ── Разбивка по поворотам ─────────────────────────────────────
        arsort($turnDirs);

        return [
            'score'          => $score,
            'path_quality'   => round($pathQuality, 3),
            'turn_simplicity'=> round($turnSimplicity, 3),
            'breakdown'      => [
                'total_distance_m'   => (int) ($route['total_distance'] ?? $totalMeters),
                'total_duration_min' => (int) round(($route['total_duration'] ?? 0) / 60),
                'road_crossings'     => $roadCrossings,
                'zones'              => $zones,
                'turns'              => $turnDirs,
                'turn_count'         => count($turnAngles),
                'sharp_turns'        => count(array_filter($turnAngles, fn($a) => $a >= 120)),
            ],
        ];
    }
}
