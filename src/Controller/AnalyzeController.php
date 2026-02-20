<?php

namespace App\Controller;

use App\Service\OpenAiService;
use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\Routing\Attribute\Route;

/**
 * AI-оценка маршрута через ChatGPT.
 *
 * POST /api/analyze
 * Body: { duration_min, distance_m, maneuvers: [{type, comment, distance}] }
 */
#[Route('/api/analyze', methods: ['POST'])]
class AnalyzeController extends AbstractController
{
    public function __construct(private readonly OpenAiService $openai) {}

    #[Route('')]
    public function __invoke(Request $request): JsonResponse
    {
        $input = json_decode($request->getContent(), true);

        if (!$input) {
            return $this->json(['error' => 'Invalid JSON'], 400);
        }

        $result = $this->openai->scoreRoute(
            durationMin: (int)   ($input['duration_min'] ?? 0),
            distanceM:   (int)   ($input['distance_m']   ?? 0),
            maneuvers:   (array) ($input['maneuvers']    ?? []),
        );

        return $this->json([
            'score' => $result['score'],
            'html'  => nl2br(htmlspecialchars($result['summary'], ENT_QUOTES, 'UTF-8')),
        ]);
    }
}
