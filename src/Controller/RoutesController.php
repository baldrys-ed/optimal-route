<?php

namespace App\Controller;

use App\Service\RouteScoreService;
use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\Routing\Attribute\Route;

/**
 * Список и детали сохранённых маршрутов из var/routes/.
 *
 * GET /api/routes          — список всех маршрутов с оценками
 * GET /api/routes/{id}     — детали одного маршрута + полная разбивка оценки
 */
#[Route('/api/routes')]
class RoutesController extends AbstractController
{
    public function __construct(private readonly RouteScoreService $scorer) {}

    #[Route('', methods: ['GET'])]
    public function list(): JsonResponse
    {
        $dir   = $this->getParameter('kernel.project_dir') . '/var/routes';
        $files = glob($dir . '/route_*.json') ?: [];
        rsort($files); // новейшие первыми

        $result = [];
        foreach ($files as $file) {
            $data  = json_decode(file_get_contents($file), true);
            $route = $data['route'] ?? null;
            if (!$route) {
                continue;
            }

            $score = $this->scorer->score($route);
            $id    = basename($file, '.json');
            $id    = preg_replace('/^route_/', '', $id);

            $result[] = [
                'id'          => $id,
                'saved_at'    => $data['saved_at']  ?? '',
                'transport'   => $data['transport'] ?? 'walking',
                'from'        => $data['from'] ?? null,
                'to'          => $data['to']   ?? null,
                'distance_m'  => $route['total_distance'] ?? 0,
                'duration_min'=> (int) round(($route['total_duration'] ?? 0) / 60),
                'ui_distance' => ($route['ui_total_distance']['value'] ?? '') . ' '
                               . ($route['ui_total_distance']['unit']  ?? ''),
                'ui_duration' => $route['ui_total_duration'] ?? '',

                'score'           => $score['score'],
                'path_quality'    => $score['path_quality'],
                'crossing_safety' => $score['crossing_safety'],
                'turn_simplicity' => $score['turn_simplicity'],

                'road_crossings' => $score['breakdown']['road_crossings'],
                'sharp_turns'    => $score['breakdown']['sharp_turns'],
                'zones'          => $score['breakdown']['zones'],
            ];
        }

        return $this->json($result);
    }

    #[Route('/{id}', methods: ['GET'], requirements: ['id' => '[\d_]+'])]
    public function detail(string $id): JsonResponse
    {
        $file = $this->getParameter('kernel.project_dir') . '/var/routes/route_' . $id . '.json';

        if (!file_exists($file)) {
            return $this->json(['error' => 'Route not found'], 404);
        }

        $data  = json_decode(file_get_contents($file), true);
        $route = $data['route'] ?? null;

        if (!$route) {
            return $this->json(['error' => 'Invalid route data'], 422);
        }

        $score = $this->scorer->score($route);

        return $this->json([
            'id'          => $id,
            'saved_at'    => $data['saved_at']  ?? '',
            'transport'   => $data['transport'] ?? 'walking',
            'from'        => $data['from'] ?? null,
            'to'          => $data['to']   ?? null,

            'score'           => $score['score'],
            'path_quality'    => $score['path_quality'],
            'crossing_safety' => $score['crossing_safety'],
            'turn_simplicity' => $score['turn_simplicity'],
            'breakdown'       => $score['breakdown'],

            'route' => $route,
        ]);
    }
}
