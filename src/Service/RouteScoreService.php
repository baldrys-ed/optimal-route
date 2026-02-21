<?php

namespace App\Service;

/**
 * Калькулятор оценки пешеходного маршрута на основе данных 2GIS Routing API.
 *
 * Формула:
 *   SCORE = path_quality * 0.55 + crossing_safety * 0.30 + turn_simplicity * 0.15
 *
 *   path_quality    — взвешенная средняя по типам покрытия (park_path, stairway, normal …)
 *   crossing_safety — безопасность переходов через дорогу (светофор > зебра > без разметки)
 *   turn_simplicity — прямолинейность маршрута (штраф за острые повороты)
 */
class RouteScoreService
{
    /** Веса комфортности по типу покрытия из geometry[].style */
    private const STYLE_WEIGHTS = [
        'park_path'      => 1.0,
        'living_zone'    => 0.9,
        'undergroundway' => 0.85,
        'archway'        => 0.7,
        'normal'         => 0.5,
        'crosswalk'      => 0.3,
        'stairway'       => 0.1,
    ];

    private const STYLE_LABELS = [
        'park_path'      => 'Парк / бульвар',
        'living_zone'    => 'Жилая зона',
        'undergroundway' => 'Подземный переход',
        'archway'        => 'Арка / проход',
        'normal'         => 'Тротуар',
        'crosswalk'      => 'Пешеходный переход',
        'stairway'       => 'Лестница',
    ];

    /** Безопасность перехода по атрибуту манёвра pedestrian_road_crossing */
    private const CROSSING_SAFETY = [
        'on_traffic_light' => 1.0,   // светофор
        'onto_crosswalk'   => 0.6,   // зебра без светофора
        'empty'            => 0.2,   // без разметки
    ];

    private const CROSSING_LABELS = [
        'on_traffic_light' => 'Со светофором',
        'onto_crosswalk'   => 'По зебре',
        'empty'            => 'Без разметки',
        'none'             => 'Не определён',
    ];

    /** Веса компонентов итоговой формулы */
    private const W_PATH  = 0.55;
    private const W_CROSS = 0.30;
    private const W_TURNS = 0.15;

    public function score(array $route): array
    {
        $maneuvers = $route['maneuvers'] ?? [];

        $styleMeters     = [];
        $turnAngles      = [];
        $turnDirs        = [];
        $crossings       = [];   // [{attr, style}, …] — каждый road_crossing

        foreach ($maneuvers as $maneuver) {
            $type = $maneuver['type'] ?? '';
            $attr = $maneuver['attribute'] ?? 'none';

            if ($type === 'pedestrian_road_crossing') {
                $crossings[] = ['attr' => $attr];
            }

            // pedestrian_crossroad с атрибутом перехода тоже является пересечением дороги.
            // Исключаем подземные переходы — у них стиль undergroundway в geometry.
            if ($type === 'pedestrian_crossroad'
                && in_array($attr, ['onto_crosswalk', 'on_traffic_light'], true)
            ) {
                $geoStyles = array_column($maneuver['outcoming_path']['geometry'] ?? [], 'style');
                if (!in_array('undergroundway', $geoStyles, true)) {
                    $crossings[] = ['attr' => $attr];
                }
            }

            if ($type === 'pedestrian_crossroad' && isset($maneuver['turn_angle'])) {
                $turnAngles[] = abs($maneuver['turn_angle']);
            }

            if (isset($maneuver['turn_direction'])) {
                $dir = $maneuver['turn_direction'];
                $turnDirs[$dir] = ($turnDirs[$dir] ?? 0) + 1;
            }

            foreach ($maneuver['outcoming_path']['geometry'] ?? [] as $geo) {
                $style  = $geo['style']  ?? 'normal';
                $length = $geo['length'] ?? 0;
                $styleMeters[$style] = ($styleMeters[$style] ?? 0) + $length;
            }
        }

        // ── 1. Path quality ───────────────────────────────────────────
        $totalMeters = array_sum($styleMeters);
        $weightedSum = 0.0;
        foreach ($styleMeters as $style => $meters) {
            $weightedSum += $meters * (self::STYLE_WEIGHTS[$style] ?? 0.5);
        }
        $pathQuality = $totalMeters > 0 ? $weightedSum / $totalMeters : 0.5;

        // ── 2. Crossing safety ────────────────────────────────────────
        // avg_safety    — средняя безопасность одного перехода по типу
        // quantity_penalty — штраф за количество: exp(−0.08 × n)
        //   0 переходов → 1.0, 6 → 0.62, 10 → 0.45, 14 → 0.33
        $crossingCount = count($crossings);
        if ($crossingCount === 0) {
            $crossingSafety = 1.0;   // нет переходов — максимум
        } else {
            $safetySum = 0.0;
            foreach ($crossings as $c) {
                $safetySum += self::CROSSING_SAFETY[$c['attr']] ?? 0.2;
            }
            $avgSafety       = $safetySum / $crossingCount;
            $quantityPenalty = exp(-0.05 * $crossingCount);
            $crossingSafety  = $avgSafety * $quantityPenalty;
        }

        // ── 3. Turn simplicity ────────────────────────────────────────
        $turnSimplicity = 1.0;
        if (count($turnAngles) > 0) {
            $avgAngle       = array_sum($turnAngles) / count($turnAngles);
            $turnSimplicity = 1.0 - ($avgAngle / 180.0);
        }

        // ── Итоговый балл ─────────────────────────────────────────────
        $score = round(
            ($pathQuality * self::W_PATH + $crossingSafety * self::W_CROSS + $turnSimplicity * self::W_TURNS) * 10,
            1
        );

        // ── Разбивка по зонам ─────────────────────────────────────────
        arsort($styleMeters);
        $zones = [];
        foreach ($styleMeters as $style => $meters) {
            $weight = self::STYLE_WEIGHTS[$style] ?? 0.5;
            $zones[$style] = [
                'label'        => self::STYLE_LABELS[$style] ?? $style,
                'meters'       => (int) round($meters),
                'percent'      => $totalMeters > 0 ? (int) round($meters / $totalMeters * 100) : 0,
                'weight'       => $weight,
                'contribution' => (int) round($meters * $weight),
            ];
        }

        // ── Разбивка по переходам ─────────────────────────────────────
        $crossingsByAttr = [];
        foreach ($crossings as $c) {
            $a = $c['attr'];
            $crossingsByAttr[$a] = ($crossingsByAttr[$a] ?? 0) + 1;
        }
        $crossingDetail = [];
        foreach ($crossingsByAttr as $attr => $cnt) {
            $crossingDetail[] = [
                'label'  => self::CROSSING_LABELS[$attr] ?? $attr,
                'count'  => $cnt,
                'safety' => self::CROSSING_SAFETY[$attr] ?? 0.2,
            ];
        }

        arsort($turnDirs);

        $avgAngle = count($turnAngles) > 0
            ? round(array_sum($turnAngles) / count($turnAngles), 1)
            : 0.0;

        return [
            'score'          => $score,
            'path_quality'   => round($pathQuality, 3),
            'crossing_safety'=> round($crossingSafety, 3),
            'turn_simplicity'=> round($turnSimplicity, 3),
            'breakdown'      => [
                'total_distance_m'   => (int) ($route['total_distance'] ?? $totalMeters),
                'total_duration_min' => (int) round(($route['total_duration'] ?? 0) / 60),
                'road_crossings'     => $crossingCount,
                'crossing_detail'    => $crossingDetail,
                'zones'              => $zones,
                'turns'              => $turnDirs,
                'turn_count'         => count($turnAngles),
                'sharp_turns'        => count(array_filter($turnAngles, fn($a) => $a >= 120)),
                'avg_turn_angle'     => $avgAngle,
                'weighted_sum'       => (int) round($weightedSum),
                'total_meters'       => (int) round($totalMeters),
            ],
        ];
    }
}
