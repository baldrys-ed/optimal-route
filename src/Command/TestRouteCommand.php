<?php

namespace App\Command;

use App\Service\RouteScoreService;
use App\Service\TwogisApiService;
use Symfony\Component\Console\Attribute\AsCommand;
use Symfony\Component\Console\Command\Command;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Input\InputOption;
use Symfony\Component\Console\Output\OutputInterface;
use Symfony\Component\Console\Style\SymfonyStyle;

/**
 * Построить маршрут и получить оценку.
 *
 * php bin/console app:test-route
 * php bin/console app:test-route --from="37.582591,55.775364" --to="37.656625,55.765036"
 * php bin/console app:test-route --transport=walking
 */
#[AsCommand(name: 'app:test-route', description: 'Построить маршрут и получить оценку')]
class TestRouteCommand extends Command
{
    public function __construct(
        private readonly TwogisApiService  $twogis,
        private readonly RouteScoreService $scorer,
    ) {
        parent::__construct();
    }

    protected function configure(): void
    {
        $this
            ->addOption('from',      null, InputOption::VALUE_REQUIRED, 'Старт "lon,lat"', '37.582591,55.775364')
            ->addOption('to',        null, InputOption::VALUE_REQUIRED, 'Финиш "lon,lat"', '37.656625,55.765036')
            ->addOption('transport', null, InputOption::VALUE_REQUIRED, 'Тип маршрута',     'walking');
    }

    protected function execute(InputInterface $input, OutputInterface $output): int
    {
        $io = new SymfonyStyle($input, $output);

        [$fromLon, $fromLat] = array_map('floatval', explode(',', $input->getOption('from')));
        [$toLon,   $toLat]   = array_map('floatval', explode(',', $input->getOption('to')));
        $transport           = $input->getOption('transport');

        $io->title("Маршрут: [{$fromLon},{$fromLat}] → [{$toLon},{$toLat}] ({$transport})");

        // ── 1. Строим маршрут ──────────────────────────────────────────
        $io->section('1. Запрос к 2GIS Routing API');

        $routeData = $this->twogis->buildRoute(
            points: [
                ['lon' => $fromLon, 'lat' => $fromLat, 'type' => 'stop'],
                ['lon' => $toLon,   'lat' => $toLat,   'type' => 'stop'],
            ],
            transport: $transport,
        );

        if (isset($routeData['_error'])) {
            $io->warning('2GIS ошибка: ' . $routeData['_error'] . '. Используем тестовые данные.');
            $path      = dirname(__DIR__, 2) . '/public/response_simple.json';
            $routeData = json_decode(file_get_contents($path), true);
        }

        $route = $routeData['result'][0] ?? null;
        if (!$route) {
            $io->error('Маршрут не найден');
            return Command::FAILURE;
        }

        $km  = round(($route['total_distance'] ?? 0) / 1000, 1);
        $min = round(($route['total_duration'] ?? 0) / 60);

        $io->definitionList(
            ['Расстояние' => "{$km} км"],
            ['Время'      => "{$min} мин"],
            ['Алгоритм'   => $route['algorithm'] ?? '—'],
        );

        // ── 2. Оценка маршрута ─────────────────────────────────────────
        $io->section('2. Оценка маршрута');

        $result    = $this->scorer->score($route);
        $breakdown = $result['breakdown'];

        $io->definitionList(
            ['Качество покрытия (path_quality)'   => $result['path_quality'] . ' / 1.0'],
            ['Прямолинейность (turn_simplicity)'  => $result['turn_simplicity'] . ' / 1.0'],
        );

        // ── 3. Зоны покрытия ───────────────────────────────────────────
        $io->section('3. Покрытие маршрута по типам зон');

        $zoneRows = [];
        foreach ($breakdown['zones'] as $style => $zone) {
            $bar        = str_repeat('█', (int) round($zone['percent'] / 5));
            $zoneRows[] = [
                $zone['label'],
                $zone['meters'] . ' м',
                $zone['percent'] . '%',
                str_pad($bar, 20),
                $zone['weight'],
            ];
        }

        $io->table(
            ['Тип зоны', 'Метров', '%', 'Доля', 'Комфорт'],
            $zoneRows,
        );

        // ── 4. Повороты ────────────────────────────────────────────────
        $io->section('4. Повороты');

        $turnLabels = [
            'straight'     => 'Прямо',
            'keep_right'   => 'Правее',
            'keep_left'    => 'Левее',
            'right'        => 'Направо',
            'left'         => 'Налево',
            'sharply_right'=> 'Резко направо',
            'sharply_left' => 'Резко налево',
        ];

        $turnRows = [];
        foreach ($breakdown['turns'] as $dir => $count) {
            $turnRows[] = [$turnLabels[$dir] ?? $dir, $count];
        }

        $io->table(['Направление', 'Кол-во'], $turnRows);

        $io->definitionList(
            ['Перекрёстков с поворотом'  => $breakdown['turn_count']],
            ['Из них резких (≥120°)'     => $breakdown['sharp_turns']],
            ['Пересечений дороги'        => $breakdown['road_crossings']],
        );

        // ── 5. Итог ────────────────────────────────────────────────────
        $io->section('5. Итоговая оценка');

        $score = $result['score'];
        $label = match(true) {
            $score >= 8.0 => 'Отлично — комфортный маршрут',
            $score >= 6.5 => 'Хорошо — преимущественно комфортный',
            $score >= 5.0 => 'Умеренно — есть проблемные участки',
            $score >= 3.5 => 'Неудобно — много неприятных зон',
            default       => 'Плохо — маршрут некомфортный',
        };

        $io->success("Оценка: {$score} / 10 — {$label}");

        return Command::SUCCESS;
    }
}
