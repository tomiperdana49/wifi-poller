<?php
declare(strict_types=1);

/**
 * Menyimpan hasil tiap siklus poller (per controller + ringkasan siklus)
 * ke poller_controller_runs / poller_cycles, dibaca dashboard untuk panel
 * "Status Poller". Lihat sql/001_poller_health.sql.
 */
final class HealthStore
{
    public function __construct(private PDO $pdo) {}

    /**
     * @param array<int,array{label:string,type:string,ok:bool,clients:int,duration_ms:int,error:?string}> $runs
     */
    public function record(string $ts, array $runs, array $cycle): void
    {
        $this->pdo->beginTransaction();
        try {
            $stmt = $this->pdo->prepare(
                'INSERT INTO poller_controller_runs
                   (ts, label, type, ok, clients, duration_ms, error)
                 VALUES (?, ?, ?, ?, ?, ?, ?)'
            );
            foreach ($runs as $r) {
                $stmt->execute([
                    $ts, $r['label'], $r['type'], $r['ok'] ? 1 : 0,
                    $r['clients'], $r['duration_ms'], self::trim($r['error']),
                ]);
            }

            $this->pdo->prepare(
                'INSERT INTO poller_cycles
                   (ts, status, duration_ms, controllers_ok, controllers_total,
                    clients, resolved, error)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
            )->execute([
                $ts, $cycle['status'], $cycle['duration_ms'],
                $cycle['controllers_ok'], $cycle['controllers_total'],
                $cycle['clients'], $cycle['resolved'], self::trim($cycle['error']),
            ]);

            $this->pdo->commit();
        } catch (Throwable $e) {
            $this->pdo->rollBack();
            throw $e;
        }
    }

    private static function trim(?string $s): ?string
    {
        return $s === null ? null : mb_substr($s, 0, 500);
    }
}
