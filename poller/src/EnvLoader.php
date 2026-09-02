<?php
declare(strict_types=1);

/**
 * Parser .env minimal, tanpa dependency composer. Format: KEY=value,
 * baris kosong dan '#' diabaikan, quote di sekeliling value opsional.
 */
final class EnvLoader
{
    /** @return array<string,string> */
    public static function load(string $path): array
    {
        $vars = [];
        if (!is_readable($path)) {
            return $vars;
        }

        foreach (file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
            $line = trim($line);
            if ($line === '' || str_starts_with($line, '#') || !str_contains($line, '=')) {
                continue;
            }

            [$key, $val] = explode('=', $line, 2);
            $key = trim($key);
            $val = trim($val);

            if (strlen($val) >= 2 && ($val[0] === '"' || $val[0] === "'") && $val[-1] === $val[0]) {
                $val = substr($val, 1, -1);
            }

            $vars[$key] = $val;
        }

        return $vars;
    }

    public static function bool(array $env, string $key, bool $default = false): bool
    {
        $v = $env[$key] ?? null;
        if ($v === null || $v === '') {
            return $default;
        }
        return in_array(strtolower($v), ['1', 'true', 'yes', 'on'], true);
    }

    /** @return string[] */
    public static function list(array $env, string $key): array
    {
        $v = trim($env[$key] ?? '');
        if ($v === '') {
            return [];
        }
        return array_values(array_filter(array_map('trim', explode(',', $v))));
    }
}
