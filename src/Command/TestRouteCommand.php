<?php

namespace App\Command;

use App\Service\OpenAiService;
use App\Service\TwogisApiService;
use Symfony\Component\Console\Attribute\AsCommand;
use Symfony\Component\Console\Command\Command;
use Symfony\Component\Console\Input\InputArgument;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Input\InputOption;
use Symfony\Component\Console\Output\OutputInterface;
use Symfony\Component\Console\Style\SymfonyStyle;

/**
 * Построить маршрут и получить AI-оценку.
 *
 * php bin/console app:test-route
 * php bin/console app:test-route --from="37.582591,55.775364" --to="37.656625,55.765036"
 * php bin/console app:test-route --transport=driving
 */
#[AsCommand(name: 'app:test-route', description: 'Построить маршрут и получить оценку через ChatGPT')]
class TestRouteCommand extends Command
{
    public function __construct(
        private readonly TwogisApiService $twogis,
        private readonly OpenAiService    $openai,
    ) {
        parent::__construct();
    }

    protected function configure(): void
    {
        $this
            ->addOption('from',      null, InputOption::VALUE_REQUIRED, 'Старт "lon,lat"',  '37.582591,55.775364')
            ->addOption('to',        null, InputOption::VALUE_REQUIRED, 'Финиш "lon,lat"',  '37.656625,55.765036')
            ->addOption('transport', null, InputOption::VALUE_REQUIRED, 'Тип маршрута',      'walking');
    }

    protected function execute(InputInterface $input, OutputInterface $output): int
    {
        $io = new SymfonyStyle($input, $output);

        [$fromLon, $fromLat] = array_map('floatval', explode(',', $input->getOption('from')));
        [$toLon,   $toLat]   = array_map('floatval', explode(',', $input->getOption('to')));
        $transport           = $input->getOption('transport');

        $io->title("Маршрут: [{$fromLon},{$fromLat}] → [{$toLon},{$toLat}] ({$transport})");

        // ── Строим маршрут ────────────────────────────────────────
        $io->section('1. Запрос к 2GIS Routing API');
        $routeData = $this->twogis->buildRoute(
            points: [
                ['lon' => $fromLon, 'lat' => $fromLat, 'type' => 'stop'],
                ['lon' => $toLon,   'lat' => $toLat,   'type' => 'stop'],
            ],
            transport: $transport,
        );

        if (isset($routeData['_error'])) {
            $io->error('2GIS ошибка: ' . $routeData['_error']);
            $io->note('Используем тестовые данные из response_simple.json...');
            $path      = dirname(__DIR__, 2) . '/public/response_simple.json';
            $routeData = json_decode(file_get_contents($path), true);
        }

        $route = $routeData['result'][0] ?? null;
        if (!$route) {
            $io->error('Маршрут не найден');
            return Command::FAILURE;
        }

        $min = round($route['total_duration'] / 60);
        $km  = round($route['total_distance'] / 1000, 1);
        $io->definitionList(
            ['Расстояние'  => "{$km} км ({$route['total_distance']} м)"],
            ['Время'       => "{$min} мин ({$route['total_duration']} с)"],
            ['Алгоритм'    => $route['algorithm'] ?? '—'],
            ['Тип'         => $route['type'] ?? '—'],
        );

        // ── Анализ манёвров ───────────────────────────────────────
        $io->section('2. Манёвры маршрута');
        $maneuvers   = $route['maneuvers'] ?? [];
        $crossings   = 0;
        $crossTypes  = ['pedestrian_road_crossing', 'crossroad', 'crossroad_left', 'crossroad_right'];
        $tableRows   = [];

        foreach ($maneuvers as $m) {
            $type    = $m['type']    ?? '?';
            $comment = $m['comment'] ?? '?';
            $dist    = $m['outcoming_path']['distance'] ?? 0;

            if (in_array($type, $crossTypes, true)) {
                $crossings++;
            }

            $tableRows[] = [$type, $comment, $dist ? "{$dist} м" : '—'];
        }

        $io->table(['type', 'comment', 'distance'], $tableRows);
        $io->text("Пересечений/поворотов: <comment>{$crossings}</comment>");

        // ── AI-оценка ─────────────────────────────────────────────
        $io->section('3. AI-оценка маршрута (ChatGPT)');
        $io->text('Отправляю запрос...');

        $aiManeuvers = array_map(fn($m) => [
            'type'     => $m['type']    ?? '',
            'comment'  => $m['comment'] ?? '',
            'distance' => $m['outcoming_path']['distance'] ?? 0,
        ], $maneuvers);

        $result = $this->openai->scoreRoute((int)$min, (int)$route['total_distance'], $aiManeuvers);

        if ($result['score'] === null) {
            $io->warning('AI не вернул оценку: ' . $result['summary']);
        } else {
            $io->success("AI-оценка: {$result['score']}/10");
            $io->text($result['summary']);
        }

        return Command::SUCCESS;
    }
}
