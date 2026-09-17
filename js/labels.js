// Local label map: YAMNet class indices → Lao phrase + severity tier.
// No network. Indices refer to model/yamnet_class_map.csv (column "index").
// Several YAMNet classes collapse into one group so the user sees one alert,
// not "Police car" + "Siren" + "Emergency vehicle" at once.
//
// NOTE: Lao text should be reviewed by a native signer/reader (e.g. Lao
// Association of the Deaf) before field use.

export const TIERS = {
  danger: {
    lo: 'ອັນຕະລາຍ', en: 'Danger', rank: 3,
    threshold: 0.30,
    vibrate: [400, 120, 400, 120, 400, 120, 600],
    cooldownMs: 2500,
  },
  caution: {
    lo: 'ລະວັງ', en: 'Caution', rank: 2,
    threshold: 0.40,
    vibrate: [220, 120, 220],
    cooldownMs: 4000,
  },
  info: {
    lo: 'ຂໍ້ມູນ', en: 'Info', rank: 1,
    threshold: 0.55,
    vibrate: [70],
    cooldownMs: 8000,
  },
};

// threshold overrides the tier default when present.
export const GROUPS = [
  // ── danger ────────────────────────────────────────────────────────────
  { id: 'horn', tier: 'danger', lo: 'ມີສຽງແກລົດ', en: 'Vehicle horn', classes: [302, 312], threshold: 0.25 },
  { id: 'siren', tier: 'danger', lo: 'ມີສຽງໄຊເຣນ ລົດສຸກເສີນ', en: 'Siren / emergency vehicle', classes: [316, 317, 318, 319, 390, 391] },
  { id: 'motorbike', tier: 'danger', lo: 'ມີລົດຈັກຢູ່ໃກ້', en: 'Motorbike / revving engine', classes: [320, 347] },
  { id: 'vehicle_pass', tier: 'danger', lo: 'ມີລົດແລ່ນຜ່ານໃກ້', en: 'Car / truck / bus passing', classes: [308, 310, 315], threshold: 0.35 },
  { id: 'skid', tier: 'danger', lo: 'ລົດເບຣກແຮງ', en: 'Skidding / tyre squeal', classes: [306, 307], threshold: 0.25 },
  { id: 'train', tier: 'danger', lo: 'ມີລົດໄຟ', en: 'Train', classes: [323, 324, 325], threshold: 0.35 },
  { id: 'fire_alarm', tier: 'danger', lo: 'ສັນຍານເຕືອນໄຟໄໝ້', en: 'Fire / smoke alarm', classes: [393, 394] },
  { id: 'explosion', tier: 'danger', lo: 'ສຽງລະເບີດ ຫຼື ສຽງປືນ', en: 'Explosion / gunshot', classes: [420, 421, 422, 424] },
  { id: 'scream', tier: 'danger', lo: 'ມີຄົນຮ້ອງສຽງດັງ', en: 'Screaming', classes: [11], threshold: 0.35 },
  { id: 'crash', tier: 'danger', lo: 'ມີສິ່ງຂອງແຕກ ຫຼື ຕຳກັນ', en: 'Glass breaking / crash', classes: [437, 463], threshold: 0.35 },

  // ── caution ───────────────────────────────────────────────────────────
  { id: 'shout', tier: 'caution', lo: 'ມີຄົນຮ້ອງເອີ້ນ', en: 'Shouting / calling out', classes: [6, 7, 9, 10] },
  { id: 'dog', tier: 'caution', lo: 'ມີໝາເຫົ່າ', en: 'Dog barking', classes: [69, 70, 117], threshold: 0.45 },
  { id: 'reversing', tier: 'caution', lo: 'ມີລົດກຳລັງຖອຍຫຼັງ', en: 'Reversing beeps', classes: [313] },
  { id: 'vehicle', tier: 'caution', lo: 'ມີລົດຢູ່ໃກ້', en: 'Motor vehicle nearby', classes: [294, 300, 301], threshold: 0.6 },
  { id: 'doorbell', tier: 'caution', lo: 'ມີຄົນກົດກະດິ່ງປະຕູ', en: 'Doorbell', classes: [349, 350], threshold: 0.35 },
  { id: 'knock', tier: 'caution', lo: 'ມີຄົນເຄາະປະຕູ', en: 'Knock', classes: [353], threshold: 0.45 },
  { id: 'phone', tier: 'caution', lo: 'ໂທລະສັບດັງ', en: 'Phone ringing', classes: [383, 384, 385], threshold: 0.45 },
  { id: 'alarm', tier: 'caution', lo: 'ມີສຽງສັນຍານເຕືອນ', en: 'Alarm / buzzer / car alarm', classes: [304, 382, 389, 392] },
  { id: 'bike_bell', tier: 'caution', lo: 'ມີກະດິ່ງລົດຖີບ', en: 'Bicycle bell', classes: [198] },
  { id: 'whistle', tier: 'caution', lo: 'ມີສຽງຫວີດ', en: 'Whistle', classes: [35, 396], threshold: 0.45 },
  { id: 'thunder', tier: 'caution', lo: 'ຟ້າຮ້ອງ', en: 'Thunder', classes: [280, 281], threshold: 0.45 },
  { id: 'baby', tier: 'caution', lo: 'ເດັກນ້ອຍຮ້ອງໄຫ້', en: 'Baby crying', classes: [20], threshold: 0.45 },
  { id: 'crying', tier: 'caution', lo: 'ມີຄົນຮ້ອງໄຫ້', en: 'Crying', classes: [19], threshold: 0.5 },
  { id: 'construction', tier: 'caution', lo: 'ມີເຄື່ອງຈັກກໍ່ສ້າງ', en: 'Chainsaw / jackhammer / drill', classes: [341, 414, 419], threshold: 0.45 },
  { id: 'fireworks', tier: 'caution', lo: 'ສຽງບັ້ງໄຟ ຫຼື ປະທັດ', en: 'Fireworks / firecracker', classes: [426, 427] },

  // ── info ──────────────────────────────────────────────────────────────
  { id: 'speech', tier: 'info', lo: 'ມີຄົນເວົ້າຢູ່ໃກ້', en: 'Speech', classes: [0, 1], threshold: 0.65 },
  { id: 'crowd', tier: 'info', lo: 'ມີຄົນຫຼາຍ', en: 'Crowd', classes: [64, 65] },
  { id: 'laughter', tier: 'info', lo: 'ມີຄົນຫົວ', en: 'Laughter', classes: [13] },
  { id: 'temple_drum', tier: 'info', lo: 'ສຽງກອງ ຫຼື ຄ້ອງ', en: 'Drum / gong', classes: [159, 163, 172], threshold: 0.45 },
  { id: 'bell', tier: 'info', lo: 'ສຽງລະຄັງ', en: 'Bell / chime', classes: [195, 196, 200], threshold: 0.45 },
  { id: 'chant', tier: 'info', lo: 'ສຽງສູດມົນ', en: 'Chanting', classes: [27, 28], threshold: 0.45 },
  { id: 'music', tier: 'info', lo: 'ມີສຽງດົນຕີ', en: 'Music', classes: [132], threshold: 0.6 },
  { id: 'rain', tier: 'info', lo: 'ຝົນຕົກ', en: 'Rain', classes: [283, 284, 285], threshold: 0.5 },
  { id: 'rooster', tier: 'info', lo: 'ໄກ່ຂັນ', en: 'Rooster / chicken', classes: [94, 96], threshold: 0.5 },
  { id: 'cat', tier: 'info', lo: 'ມີແມວ', en: 'Cat', classes: [76, 78], threshold: 0.5 },
  { id: 'vendor_jingle', tier: 'info', lo: 'ລົດຂາຍເຄື່ອງ (ສຽງເພງ)', en: 'Vendor truck jingle', classes: [314], threshold: 0.4 },
  { id: 'engine_idle', tier: 'info', lo: 'ມີເຄື່ອງຈັກລົດຕິດຢູ່', en: 'Engine starting / idling', classes: [345, 346], threshold: 0.5 },
  { id: 'traffic', tier: 'info', lo: 'ສຽງລົດຫຼາຍ (ຖະໜົນ)', en: 'Traffic noise', classes: [321], threshold: 0.6 },
  { id: 'water', tier: 'info', lo: 'ນ້ຳໄຫຼ', en: 'Running water', classes: [364], threshold: 0.6 },
  { id: 'door', tier: 'info', lo: 'ສຽງປະຕູ', en: 'Door', classes: [348, 351] },
];
