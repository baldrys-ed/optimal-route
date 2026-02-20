<?php

namespace App\Controller;

use App\Service\OpenAiService;
use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\Routing\Attribute\Route;

/**
 * Анализ скриншота карты через OpenAI Vision.
 *
 * POST /api/analyze-vision
 * Body: { image: <base64 jpeg>, duration_min, distance_m, unsafe_crossings, safe_crossings }
 */
#[Route('/api/analyze-vision', methods: ['POST'])]
class VisionController extends AbstractController
{
    public function __construct(private readonly OpenAiService $openai) {}

    #[Route('')]
    public function __invoke(Request $request): JsonResponse
    {
        $input = json_decode($request->getContent(), true);

        if (empty($input['image'])) {
            return $this->json(['error' => 'image required'], 400);
        }

        $result = $this->openai->analyzeMapImage(
            base64Image:     (string) $input['image'],
            durationMin:     (int)    ($input['duration_min']    ?? 0),
            distanceM:       (int)    ($input['distance_m']      ?? 0),
            unsafeCrossings: (int)    ($input['unsafe_crossings'] ?? 0),
            safeCrossings:   (int)    ($input['safe_crossings']   ?? 0),
        );

        return $this->json($result);
    }
}
