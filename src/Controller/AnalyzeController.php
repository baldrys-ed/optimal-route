<?php

namespace App\Controller;

use App\Service\RouteScoreService;
use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\Routing\Attribute\Route;

/**
 * Оценка маршрута по данным 2GIS Routing API.
 *
 * POST /api/analyze
 * Body: result[0] из ответа 2GIS (поле route)
 *   { "route": { "maneuvers": [...], "total_distance": 6078, "total_duration": 4052, ... } }
 */
#[Route('/api/analyze', methods: ['POST'])]
class AnalyzeController extends AbstractController
{
    public function __construct(private readonly RouteScoreService $scorer) {}

    #[Route('')]
    public function __invoke(Request $request): JsonResponse
    {
        $input = json_decode($request->getContent(), true);

        if (!$input) {
            return $this->json(['error' => 'Invalid JSON'], 400);
        }

        $route = $input['route'] ?? null;

        if (!$route || empty($route['maneuvers'])) {
            return $this->json(['error' => 'route.maneuvers required'], 400);
        }

        $result = $this->scorer->score($route);

        return $this->json($result);
    }
}
