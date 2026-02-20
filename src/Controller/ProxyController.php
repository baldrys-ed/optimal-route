<?php

namespace App\Controller;

use App\Service\TwogisApiService;
use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\Routing\Attribute\Route;

/**
 * Прокси для всех 2GIS API — решает CORS и добавляет ключ на сервере.
 */
#[Route('/api')]
class ProxyController extends AbstractController
{
    public function __construct(private readonly TwogisApiService $twogis) {}

    // GET /api/routing  + POST body
    #[Route('/routing', methods: ['POST'])]
    public function routing(Request $request): JsonResponse
    {
        $body = json_decode($request->getContent(), true);

        if (!$body || empty($body['points'])) {
            return $this->json(['error' => 'points required'], 400);
        }

        $result = $this->twogis->buildRoute(
            $body['points'],
            $body['transport'] ?? 'walking',
        );

        return $this->json($result);
    }

    // GET /api/suggest?q=...
    #[Route('/suggest', methods: ['GET'])]
    public function suggest(Request $request): JsonResponse
    {
        $q = $request->query->getString('q');
        if (!$q) {
            return $this->json(['error' => 'q required'], 400);
        }

        $result = $this->twogis->suggest($q, $request->query->all());
        return $this->json($result);
    }

    // GET /api/geocode?lon=...&lat=...
    #[Route('/geocode', methods: ['GET'])]
    public function geocode(Request $request): JsonResponse
    {
        $lon = (float) $request->query->get('lon');
        $lat = (float) $request->query->get('lat');

        $result = $this->twogis->geocode($lon, $lat);
        return $this->json($result);
    }

    // GET /api/catalog?q=...&point=...&radius=...
    #[Route('/catalog', methods: ['GET'])]
    public function catalog(Request $request): JsonResponse
    {
        $result = $this->twogis->searchCatalog($request->query->all());
        return $this->json($result);
    }

    // GET /api/rubric?q=...&region_id=...
    #[Route('/rubric', methods: ['GET'])]
    public function rubric(Request $request): JsonResponse
    {
        $result = $this->twogis->searchRubric($request->query->all());
        return $this->json($result);
    }

    // GET /api/region?q=...
    #[Route('/region', methods: ['GET'])]
    public function region(Request $request): JsonResponse
    {
        $q = $request->query->getString('q');
        $result = $this->twogis->searchRegion($q);
        return $this->json($result);
    }

    // GET /api/crossing?lon=...&lat=...&radius=50
    #[Route('/crossing', methods: ['GET'])]
    public function crossing(Request $request): JsonResponse
    {
        $lon    = (float) $request->query->get('lon');
        $lat    = (float) $request->query->get('lat');
        $radius = (int)   $request->query->get('radius', 50);

        $regulated = $this->twogis->hasTrafficLight($lon, $lat, $radius);

        return $this->json([
            'lon'        => $lon,
            'lat'        => $lat,
            'radius'     => $radius,
            'regulated'  => $regulated,
        ]);
    }
}
