<?php

namespace App\Command;

use App\Service\TwogisApiService;
use Symfony\Component\Console\Attribute\AsCommand;
use Symfony\Component\Console\Command\Command;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Input\InputOption;
use Symfony\Component\Console\Output\OutputInterface;
use Symfony\Component\Console\Style\SymfonyStyle;

/**
 * Тест: поиск светофоров через 2GIS Catalog API.
 *
 * php bin/console app:test-crossing
 * php bin/console app:test-crossing --lon=37.583 --lat=55.775 --radius=80
 */
#[AsCommand(name: 'app:test-crossing', description: 'Поиск светофоров у пешеходных переходов через 2GIS Catalog')]
class TestCrossingCommand extends Command
{
    // Тестовые переходы в Москве
    private const DEFAULT_CROSSINGS = [
        ['name' => 'Тверская ул. (Тверская Застава)',        'lon' => 37.5833, 'lat' => 55.7752],
        ['name' => 'Садовое кольцо (Садовая-Триумфальная)',  'lon' => 37.5977, 'lat' => 55.7702],
        ['name' => 'Садовая-Черногрязская (конец маршрута)', 'lon' => 37.6566, 'lat' => 55.7649],
    ];

    public function __construct(private readonly TwogisApiService $twogis)
    {
        parent::__construct();
    }

    protected function configure(): void
    {
        $this
            ->addOption('lon',    null, InputOption::VALUE_REQUIRED, 'Долгота конкретной точки')
            ->addOption('lat',    null, InputOption::VALUE_REQUIRED, 'Широта конкретной точки')
            ->addOption('radius', null, InputOption::VALUE_REQUIRED, 'Радиус поиска в метрах', 50);
    }

    protected function execute(InputInterface $input, OutputInterface $output): int
    {
        $io = new SymfonyStyle($input, $output);

        // Если передана конкретная точка — проверяем только её
        if ($input->getOption('lon') && $input->getOption('lat')) {
            $lon    = (float) $input->getOption('lon');
            $lat    = (float) $input->getOption('lat');
            $radius = (int)   $input->getOption('radius');

            $io->title("Проверка точки [{$lon}, {$lat}], радиус {$radius}м");
            $this->checkCrossing($io, ['name' => 'Точка', 'lon' => $lon, 'lat' => $lat], $radius);
            return Command::SUCCESS;
        }

        // Иначе — тест всех дефолтных переходов
        $io->title('Поиск светофоров у пешеходных переходов');

        $io->section('Шаг 1: Поиск рубрики «светофор»');
        $rubrics = $this->twogis->searchRubric('светофор');
        if (isset($rubrics['_error'])) {
            $io->error('Ошибка: ' . $rubrics['_error']);
        } else {
            $result = $rubrics['result'] ?? [];
            $io->text('Найдено рубрик: ' . count($result));
            foreach ($result as $r) {
                $io->text(sprintf('  id=%-12s  name=%s', $r['id'], $r['name']));
            }
        }

        $io->section('Шаг 2: Поиск объектов «светофор» рядом с переходами');
        $radius = (int) $input->getOption('radius');

        $rows = [];
        foreach (self::DEFAULT_CROSSINGS as $cross) {
            $this->checkCrossing($io, $cross, $radius);

            // Итоговая таблица
            $regulated = $this->twogis->hasTrafficLight($cross['lon'], $cross['lat'], $radius);
            $rows[]    = [$cross['name'], $cross['lon'], $cross['lat'], $regulated ? '✅ регулируемый' : '❌ нерегулируемый'];
        }

        $io->section('Итог');
        $io->table(['Переход', 'lon', 'lat', 'Тип'], $rows);

        return Command::SUCCESS;
    }

    private function checkCrossing(SymfonyStyle $io, array $cross, int $radius): void
    {
        $io->text("→ {$cross['name']} [{$cross['lon']}, {$cross['lat']}]");

        // Поиск светофора
        $data  = $this->twogis->searchCatalog([
            'q'      => 'светофор',
            'point'  => "{$cross['lon']},{$cross['lat']}",
            'radius' => $radius,
            'sort'   => 'distance',
            'fields' => 'items.point,items.rubrics,items.name',
        ]);

        if (isset($data['_error'])) {
            $io->warning('  Ошибка: ' . $data['_error']);
            return;
        }

        $items = $data['result']['items'] ?? [];
        $total = $data['result']['total'] ?? 0;
        $io->text("  Объектов «светофор» найдено: $total");

        foreach (array_slice($items, 0, 3) as $item) {
            $name   = $item['name'] ?? '?';
            $rubric = $item['rubrics'][0]['name'] ?? '—';
            $io->text("  • «{$name}» [{$rubric}]");
        }

        // Поиск geo-объектов рядом
        $geoData  = $this->twogis->searchCatalog([
            'point'  => "{$cross['lon']},{$cross['lat']}",
            'radius' => $radius,
            'type'   => 'geo',
            'sort'   => 'distance',
            'fields' => 'items.point,items.subtype,items.name,items.rubrics',
        ]);
        $geoItems = $geoData['result']['items'] ?? [];
        $geoTotal = $geoData['result']['total'] ?? 0;
        $io->text("  Geo-объектов рядом: $geoTotal");

        foreach (array_slice($geoItems, 0, 3) as $item) {
            $name    = $item['name'] ?? '?';
            $subtype = $item['subtype'] ?? '—';
            $io->text("  • «{$name}» [subtype={$subtype}]");
        }

        $io->newLine();
    }
}
