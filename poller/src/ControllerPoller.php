<?php
declare(strict_types=1);

interface ControllerPoller
{
    /** @return ClientSample[] */
    public function fetchClients(): array;

    public function label(): string;
}


/**
 * Helper HTTP + cache token yang dipakai kedua poller.
 *
 * Token di-cache ke file dengan TTL. Jangan minta token baru tiap menit —
 * beberapa API punya rate limit di endpoint auth dan bisa memblokir Anda.
 */
abstract class BasePoller implements ControllerPoller
{
    protected array $cfg;
    protected string $tokenDir;

    public function __construct(array $cfg, string $tokenDir)
    {
        $this->cfg      = $cfg;
        $this->tokenDir = rtrim($tokenDir, '/');
    }

    public function label(): string
    {
        return $this->cfg['label'] ?? $this->cfg['type'];
    }

    /**
     * @param array<string,string> $headers
     * @return array Decoded JSON
     */
    protected function http(
        string $method,
        string $url,
        array $headers = [],
        ?array $jsonBody = null,
        int $timeout = 20
    ): array {
        $ch = curl_init();

        $opts = [
            CURLOPT_URL            => $url,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CUSTOMREQUEST  => $method,
            CURLOPT_TIMEOUT        => $timeout,
            CURLOPT_CONNECTTIMEOUT => 10,
            CURLOPT_SSL_VERIFYPEER => (bool)($this->cfg['verify_ssl'] ?? true),
            CURLOPT_SSL_VERIFYHOST => ($this->cfg['verify_ssl'] ?? true) ? 2 : 0,
        ];

        $hdr = $headers;
        if ($jsonBody !== null) {
            $opts[CURLOPT_POSTFIELDS] = json_encode($jsonBody, JSON_UNESCAPED_SLASHES);
            $hdr['Content-Type'] = 'application/json';
        }

        $opts[CURLOPT_HTTPHEADER] = array_map(
            fn($k, $v) => "$k: $v",
            array_keys($hdr),
            array_values($hdr)
        );

        curl_setopt_array($ch, $opts);

        $body = curl_exec($ch);
        $err  = curl_error($ch);
        $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);

        if ($body === false) {
            throw new RuntimeException("HTTP gagal ke $url: $err");
        }
        if ($code >= 400) {
            $cut = substr((string)$body, 0, 500);
            throw new RuntimeException("HTTP $code dari $url: $cut");
        }

        $data = json_decode((string)$body, true);
        if (!is_array($data)) {
            $cut = substr((string)$body, 0, 500);
            throw new RuntimeException("Response bukan JSON dari $url: $cut");
        }

        return $data;
    }

    protected function tokenPath(): string
    {
        $safe = preg_replace('/[^a-zA-Z0-9_-]/', '_', $this->label());
        return "{$this->tokenDir}/token_{$safe}.json";
    }

    protected function cachedToken(): ?string
    {
        $p = $this->tokenPath();
        if (!is_readable($p)) {
            return null;
        }
        $d = json_decode((string)file_get_contents($p), true);
        if (!is_array($d) || !isset($d['token'], $d['expires_at'])) {
            return null;
        }
        // Refresh 60 detik sebelum benar-benar expired
        return ($d['expires_at'] > time() + 60) ? (string)$d['token'] : null;
    }

    protected function storeToken(string $token, int $ttlSeconds): void
    {
        $p   = $this->tokenPath();
        $tmp = $p . '.tmp';
        file_put_contents($tmp, json_encode([
            'token'      => $token,
            'expires_at' => time() + $ttlSeconds,
        ]));
        @chmod($tmp, 0600);
        rename($tmp, $p);   // atomic
    }

    protected function clearToken(): void
    {
        @unlink($this->tokenPath());
    }
}
