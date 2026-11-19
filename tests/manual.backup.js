const t = require('./toxiproxy');

const [cmd, arg] = process.argv.slice(2);

(async () => {
  switch (cmd) {
    case 'setup':
      await t.createProxy();
      console.log('Proxy backend_proxy dibuat: localhost:8666 -> backend:3000');
      break;
    case 'latency':
      await t.addToxic('latency', 'latency', { latency: Number(arg || 2000), jitter: 0 });
      console.log(`Toxic latency ${arg || 2000} ms aktif`);
      break;
    case 'timeout':
      await t.addToxic('timeout', 'timeout', { timeout: 0 });
      console.log('Toxic timeout aktif (koneksi menggantung)');
      break;
    case 'reset_peer':
      await t.addToxic('reset_peer', 'reset_peer', { timeout: 0 });
      console.log('Toxic reset_peer aktif (koneksi diputus paksa)');
      break;
    case 'down':
      await t.setEnabled(false);
      console.log('Proxy DIMATIKAN (simulasi layanan mati)');
      break;
    case 'up':
      await t.setEnabled(true);
      console.log('Proxy DINYALAKAN kembali');
      break;
    case 'reset':
      await t.reset();
      console.log('Semua toxic dihapus, proxy aktif');
      break;
    case 'status':
      console.log(JSON.stringify(await t.status(), null, 2));
      break;
    default:
      console.log('Perintah: setup | latency [ms] | timeout | reset_peer | down | up | reset | status');
  }
})().catch((e) => {
  console.error('ERROR:', e.message);
  console.error('Pastikan "docker compose up -d --build" sudah dijalankan.');
  process.exit(1);
});
