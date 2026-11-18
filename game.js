/**
 * Nintendo Game & Watch: Mickey Mouse (MC-25, Wide Screen, 1981)
 * Faithful port of the authentic MADrigal simulator state machine & assets
 */

(() => {
  const ASSETS = window.GW_ASSETS;
  const canvas = document.getElementById('gw-canvas');
  const ctx = canvas.getContext('2d');

  // Preloaded HTMLImageElement map
  const imgMap = {};
  // Web Audio API context & decoded buffers
  let audioCtx = null;
  const soundBuffers = {};
  const fallbackAudio = {};
  let soundEnabled = true;
  let ghostOpacity = 0.055; // Subtle LCD unlit segment ghosting

  // Sprite state map (cloned from ASSETS.sprites)
  const sprites = {};
  const digits = {};

  // LCD screen sprite keys (for "all segments" & ghost effect)
  const lcdSpriteKeys = [
    'im_hero_w', 'im_hero_e',
    'im_hero_nw', 'im_hero_ne', 'im_hero_sw', 'im_hero_se',
    'im_enemy_nw1', 'im_enemy_nw2', 'im_enemy_nw3', 'im_enemy_nw4', 'im_enemy_nw5',
    'im_enemy_ne1', 'im_enemy_ne2', 'im_enemy_ne3', 'im_enemy_ne4', 'im_enemy_ne5',
    'im_enemy_sw1', 'im_enemy_sw2', 'im_enemy_sw3', 'im_enemy_sw4', 'im_enemy_sw5',
    'im_enemy_se1', 'im_enemy_se2', 'im_enemy_se3', 'im_enemy_se4', 'im_enemy_se5',
    'im_miss_w1', 'im_miss_w2', 'im_miss_w3', 'im_miss_w4', 'im_miss_w5', 'im_miss_w6',
    'im_miss_e1', 'im_miss_e2', 'im_miss_e3', 'im_miss_e4', 'im_miss_e5', 'im_miss_e6',
    'im_panel_alarm_1', 'im_panel_alarm_2', 'im_panel_alarm_3', 'im_panel_alarm_4', 'im_panel_alarm_5',
    'im_panel_miss_1', 'im_panel_miss_2', 'im_panel_miss_3',
    'im_panel_time_am', 'im_panel_time_pm', 'im_panel_time_colon',
    'im_panel_game_a', 'im_panel_game_b'
  ];

  // Exact speed lookup table from MADrigal's unit1.lua (lines 1353-1554)
  const SPEED_TABLE = [
    650, 635, 620, 605, 590, 575, 560, 545, 530, 515, // 0..9
    500, 485, 470, 455, 440, 425, 410, 395, 380, 365, // 10..19
    590, 575, 560, 545, 530, 515, 500, 485, 470, 455, // 20..29
    440, 425, 410, 395, 380, 365, 350, 335, 320, 305, // 30..39
    515, 500, 485, 470, 455, 440, 425, 410, 395, 380, // 40..49
    365, 350, 335, 320, 305, 290, 275, 260, 245, 230, // 50..59
    440, 425, 410, 395, 380, 365, 350, 335, 320, 305, // 60..69
    290, 275, 260, 245, 230, 225, 220, 215, 210, 205, // 70..79
    365, 350, 335, 320, 305, 290, 275, 260, 245, 230, // 80..89
    225, 220, 215, 210, 205, 200, 195, 190, 185, 180  // 90..99
  ];

  // Game state variables (matching unit1.lua)
  let bchance = false;
  let bgame = 0; // 1 = Game A, 2 = Game B
  const benemy = [
    [false, false, false, false, false, false], // 1: NW (1..5)
    [false, false, false, false, false, false], // 2: NE (1..5)
    [false, false, false, false, false, false], // 3: SW (1..5)
    [false, false, false, false, false, false]  // 4: SE (1..5)
  ];
  let ichance = 0;
  let igameover = 0;
  let ihero = 1; // 1=NW, 2=NE, 3=SW, 4=SE
  let ihiscorea = parseInt(localStorage.getItem('gw_mickey_hi_a') || '0', 10);
  let ihiscoreb = parseInt(localStorage.getItem('gw_mickey_hi_b') || '0', 10);
  const initNow = new Date();
  let ihora = initNow.getHours();
  let imin = initNow.getMinutes();
  let isec = initNow.getSeconds();
  let clockHalfTick = 0;
  let settingTarget = 'alarm'; // 'clock' (after ACL) or 'alarm' (after ALARM)
  let ihoraa = 12;
  let imina = 0;
  let imiss = 0;
  let imisse = 0;
  let imissw = 0;
  let imismatch = 0; // 0..6 (each full miss = 2, half miss = 1)
  let imode = 2; // Start in Clock/Time mode ready to play!
  let inorally = 0;
  let iobserver = 0;
  let ibonus = 0;
  let iscore = 0;
  let istep = 0;

  // Timers dictionary
  const timers = {
    clock: { enabled: false, interval: 500, id: null, fn: onTimerClock },
    observer: { enabled: false, interval: 2000, id: null, fn: onTimerObserver },
    game: { enabled: false, interval: 650, id: null, fn: onTimerGame },
    point: { enabled: false, interval: 150, id: null, fn: onTimerPoint },
    miss_long: { enabled: false, interval: 450, id: null, fn: onTimerMissLong },
    miss_short: { enabled: false, interval: 450, id: null, fn: onTimerMissShort },
    show_miss: { enabled: false, interval: 250, id: null, fn: onTimerShowMiss },
    game_over: { enabled: false, interval: 80, id: null, fn: onTimerGameOver },
    chance: { enabled: false, interval: 250, id: null, fn: onTimerChance }
  };

  function setTimerEnabled(name, enabled) {
    const t = timers[name];
    if (!t) return;
    if (t.enabled === enabled) return;
    t.enabled = enabled;
    if (t.id) {
      clearInterval(t.id);
      t.id = null;
    }
    if (enabled) {
      t.id = setInterval(t.fn, t.interval);
    }
  }

  function setTimerInterval(name, interval) {
    const t = timers[name];
    if (!t) return;
    t.interval = interval;
    if (t.enabled) {
      clearInterval(t.id);
      t.id = setInterval(t.fn, t.interval);
    }
  }

  // Audio playback
  function ensureAudioContext() {
    if (!audioCtx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (AudioContextClass) {
        audioCtx = new AudioContextClass();
        // Decode base64 WAVs into AudioBuffers for zero-latency playback
        Object.keys(ASSETS.sounds).forEach((key) => {
          const b64 = ASSETS.sounds[key];
          const binary = atob(b64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          audioCtx.decodeAudioData(bytes.buffer.slice(0), (buffer) => {
            soundBuffers[key] = buffer;
          });
        });
      }
    }
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
  }

  function playSound(name) {
    if (!soundEnabled) return;
    ensureAudioContext();
    if (audioCtx && soundBuffers[name]) {
      const source = audioCtx.createBufferSource();
      source.buffer = soundBuffers[name];
      source.connect(audioCtx.destination);
      source.start(0);
    } else if (fallbackAudio[name]) {
      try {
        fallbackAudio[name].currentTime = 0;
        fallbackAudio[name].play().catch(() => {});
      } catch (_) {}
    }
  }

  // Initialize sprites & digits from ASSETS
  function initData() {
    Object.keys(ASSETS.sprites).forEach((k) => {
      sprites[k] = { ...ASSETS.sprites[k] };
    });
    Object.keys(ASSETS.digits).forEach((k) => {
      digits[k] = { ...ASSETS.digits[k], img: null };
    });
  }

  // Core helper functions translated 1:1 from unit1.lua
  function hide_screen() {
    lcdSpriteKeys.forEach((k) => {
      if (sprites[k]) sprites[k].visible = false;
    });
    digits.im_panel_digit_1.visible = false;
    digits.im_panel_digit_2.visible = false;
    digits.im_panel_digit_3.visible = false;
    digits.im_panel_digit_4.visible = false;
  }

  function show_screen() {
    lcdSpriteKeys.forEach((k) => {
      if (sprites[k]) sprites[k].visible = true;
    });
    digits.im_panel_digit_1.img = 'im_number_1_1';
    digits.im_panel_digit_2.img = 'im_number_2_8';
    digits.im_panel_digit_3.img = 'im_number_3_8';
    digits.im_panel_digit_4.img = 'im_number_4_8';
    digits.im_panel_digit_1.visible = true;
    digits.im_panel_digit_2.visible = true;
    digits.im_panel_digit_3.visible = true;
    digits.im_panel_digit_4.visible = true;
  }

  function hide_enemies() {
    for (let i = 1; i <= 5; i++) {
      sprites[`im_enemy_nw${i}`].visible = false;
      sprites[`im_enemy_ne${i}`].visible = false;
      sprites[`im_enemy_sw${i}`].visible = false;
      sprites[`im_enemy_se${i}`].visible = false;
    }
  }

  function hide_hero() {
    sprites.im_hero_e.visible = false;
    sprites.im_hero_w.visible = false;
    sprites.im_hero_nw.visible = false;
    sprites.im_hero_ne.visible = false;
    sprites.im_hero_sw.visible = false;
    sprites.im_hero_se.visible = false;
  }

  function hide_miss() {
    for (let i = 1; i <= 6; i++) {
      sprites[`im_miss_w${i}`].visible = false;
      sprites[`im_miss_e${i}`].visible = false;
    }
  }

  function put_hero(pos) {
    hide_hero();
    if (pos === 1) {
      sprites.im_hero_w.visible = true;
      sprites.im_hero_nw.visible = true;
    } else if (pos === 2) {
      sprites.im_hero_e.visible = true;
      sprites.im_hero_ne.visible = true;
    } else if (pos === 3) {
      sprites.im_hero_w.visible = true;
      sprites.im_hero_sw.visible = true;
    } else if (pos === 4) {
      sprites.im_hero_e.visible = true;
      sprites.im_hero_se.visible = true;
    }
  }

  function put_misses(im) {
    const m = Math.floor(im / 2);
    sprites.im_panel_miss_1.visible = m >= 1;
    sprites.im_panel_miss_2.visible = m >= 2;
    sprites.im_panel_miss_3.visible = m >= 3;
  }

  function put_score(scoreVal) {
    sprites.im_panel_time_am.visible = false;
    sprites.im_panel_time_pm.visible = false;
    sprites.im_panel_time_colon.visible = false;

    const s1 = Math.floor(scoreVal / 1000) % 10;
    const s2 = Math.floor(scoreVal / 100) % 10;
    const s3 = Math.floor(scoreVal / 10) % 10;
    const s4 = scoreVal % 10;

    digits.im_panel_digit_1.visible = false;
    digits.im_panel_digit_2.visible = false;
    digits.im_panel_digit_3.visible = false;
    digits.im_panel_digit_4.visible = true;

    if (s1 === 1) {
      digits.im_panel_digit_1.img = 'im_number_1_1';
      digits.im_panel_digit_1.visible = true;
    }

    digits.im_panel_digit_2.img = `im_number_2_${s2}`;
    if (scoreVal >= 100) digits.im_panel_digit_2.visible = true;

    digits.im_panel_digit_3.img = `im_number_3_${s3}`;
    if (scoreVal >= 10) digits.im_panel_digit_3.visible = true;

    digits.im_panel_digit_4.img = `im_number_4_${s4}`;
  }

  function put_time(ih, im) {
    let h = ih;
    if (h >= 0 && h <= 11) {
      sprites.im_panel_time_am.visible = true;
      sprites.im_panel_time_pm.visible = false;
      if (h === 0) h = 12;
    } else {
      sprites.im_panel_time_am.visible = false;
      sprites.im_panel_time_pm.visible = true;
      if (h > 12) h -= 12;
    }

    digits.im_panel_digit_1.visible = false;
    digits.im_panel_digit_2.visible = true;
    digits.im_panel_digit_3.visible = true;
    digits.im_panel_digit_4.visible = true;

    if (h >= 10) {
      digits.im_panel_digit_1.img = 'im_number_1_1';
      digits.im_panel_digit_1.visible = true;
    }

    const d2 = h % 10;
    const d3 = Math.floor(im / 10) % 10;
    const d4 = im % 10;

    digits.im_panel_digit_2.img = `im_number_2_${d2}`;
    digits.im_panel_digit_3.img = `im_number_3_${d3}`;
    digits.im_panel_digit_4.img = `im_number_4_${d4}`;
  }

  function set_speed(scoreVal, chanceFlag) {
    const idx = scoreVal % 100;
    let spd = SPEED_TABLE[idx] || 300;
    if (bgame === 2) {
      spd = spd - 60;
    }
    if (chanceFlag) {
      spd = Math.floor(spd * 0.85);
    }
    setTimerInterval('game', spd);
  }

  function check_20_points() {
    if (bgame === 1 && iscore % 20 === 0) {
      let i;
      do {
        i = Math.floor(Math.random() * 4) + 1;
      } while (i === inorally);
      inorally = i;
    }
  }

  function check_100_points() {
    const mod = iscore % 1000;
    if ((mod === 200 || mod === 500) && imismatch > 0) {
      bchance = true;
      imismatch = 0;
      put_misses(imismatch);
      ichance = Math.floor(Math.random() * 20) + 55;
      setTimerEnabled('chance', true);
    }
  }

  function merge_enemies() {
    sprites.im_enemy_nw1.visible = benemy[0][1];
    sprites.im_enemy_nw2.visible = benemy[0][2];
    sprites.im_enemy_nw3.visible = benemy[0][3];
    sprites.im_enemy_nw4.visible = benemy[0][4];
    sprites.im_enemy_nw5.visible = benemy[0][5];

    sprites.im_enemy_ne1.visible = benemy[1][1];
    sprites.im_enemy_ne2.visible = benemy[1][2];
    sprites.im_enemy_ne3.visible = benemy[1][3];
    sprites.im_enemy_ne4.visible = benemy[1][4];
    sprites.im_enemy_ne5.visible = benemy[1][5];

    sprites.im_enemy_sw1.visible = benemy[2][1];
    sprites.im_enemy_sw2.visible = benemy[2][2];
    sprites.im_enemy_sw3.visible = benemy[2][3];
    sprites.im_enemy_sw4.visible = benemy[2][4];
    sprites.im_enemy_sw5.visible = benemy[2][5];

    sprites.im_enemy_se1.visible = benemy[3][1];
    sprites.im_enemy_se2.visible = benemy[3][2];
    sprites.im_enemy_se3.visible = benemy[3][3];
    sprites.im_enemy_se4.visible = benemy[3][4];
    sprites.im_enemy_se5.visible = benemy[3][5];
  }

  function count_enemies_in_rally(r) {
    let total = 0;
    for (let j = 1; j <= 5; j++) {
      if (benemy[r][j]) total++;
    }
    return total;
  }

  function count_enemies_total() {
    return (
      count_enemies_in_rally(0) +
      count_enemies_in_rally(1) +
      count_enemies_in_rally(2) +
      count_enemies_in_rally(3)
    );
  }

  function start_timers() {
    setTimerEnabled('game', true);
    setTimerEnabled('observer', true);
    if (bchance) setTimerEnabled('chance', true);
  }

  function stop_timers() {
    Object.keys(timers).forEach((k) => setTimerEnabled(k, false));
  }

  // Timer Callbacks (1:1 port of unit1.lua)
  function onTimerChance() {
    const vis = !sprites.im_panel_miss_1.visible;
    sprites.im_panel_miss_1.visible = vis;
    sprites.im_panel_miss_2.visible = vis;
    sprites.im_panel_miss_3.visible = vis;
    updateUIStatus();
  }

  function onTimerClock() {
    clockHalfTick = (clockHalfTick + 1) % 2;
    if (clockHalfTick === 0) {
      isec++;
      if (isec >= 60) {
        isec = 0;
        imin++;
        if (imin >= 60) {
          imin = 0;
          ihora = (ihora + 1) % 24;
        }
      }
      sprites.im_panel_time_colon.visible = !sprites.im_panel_time_colon.visible;
      if (imode === 2) {
        put_time(ihora, imin);
        if (ihora === ihoraa && imin === imina) {
          sprites.im_panel_alarm_1.visible = true;
          sprites.im_panel_alarm_2.visible = !sprites.im_panel_alarm_2.visible;
          sprites.im_panel_alarm_3.visible = !sprites.im_panel_alarm_2.visible;
          sprites.im_panel_alarm_4.visible = sprites.im_panel_alarm_2.visible;
          sprites.im_panel_alarm_5.visible = sprites.im_panel_alarm_3.visible;
          if (sprites.im_panel_alarm_3.visible) {
            playSound('Point');
          }
        } else {
          sprites.im_panel_alarm_1.visible = false;
          sprites.im_panel_alarm_2.visible = false;
          sprites.im_panel_alarm_3.visible = false;
          sprites.im_panel_alarm_4.visible = false;
          sprites.im_panel_alarm_5.visible = false;
        }
      }
    }

    // Demo animation in Clock Mode (imode == 2)
    if (imode === 2) {
      onTimerGame();
      for (let i = 1; i <= 4; i++) {
        if (benemy[i - 1][5]) {
          ihero = i;
          put_hero(ihero);
        }
      }
    }
    updateUIStatus();
  }

  function onTimerGameOver() {
    igameover++;
    if (igameover === 1) {
      playSound('Gameover');
    }
    if (igameover === 25) {
      setTimerEnabled('game_over', false);
      setTimerEnabled('clock', true);
    }
    updateUIStatus();
  }

  function onTimerMissLong() {
    imiss++;
    if (imiss === 1) {
      setTimerEnabled('show_miss', true);
      if (bchance) {
        bchance = false;
        setTimerEnabled('chance', false);
      }
      if (imisse > 0) sprites.im_miss_e1.visible = true;
      if (imissw > 0) sprites.im_miss_w1.visible = true;
      playSound('Miss');
    } else if (imiss === 2) {
      if (imisse > 0) {
        sprites.im_miss_e1.visible = false;
        sprites.im_miss_e2.visible = true;
      }
      if (imissw > 0) {
        sprites.im_miss_w1.visible = false;
        sprites.im_miss_w2.visible = true;
      }
      playSound('Miss');
    } else if (imiss === 3) {
      if (imisse > 0) {
        sprites.im_miss_e2.visible = false;
        sprites.im_miss_e3.visible = true;
      }
      if (imissw > 0) {
        sprites.im_miss_w2.visible = false;
        sprites.im_miss_w3.visible = true;
      }
      playSound('Miss');
    } else if (imiss === 4) {
      if (imisse > 0) {
        sprites.im_miss_e3.visible = false;
        sprites.im_miss_e4.visible = true;
      }
      if (imissw > 0) {
        sprites.im_miss_w3.visible = false;
        sprites.im_miss_w4.visible = true;
      }
      playSound('Miss');
    } else if (imiss === 5) {
      if (imisse > 0) {
        sprites.im_miss_e4.visible = false;
        sprites.im_miss_e5.visible = true;
      }
      if (imissw > 0) {
        sprites.im_miss_w4.visible = false;
        sprites.im_miss_w5.visible = true;
      }
      playSound('Miss');
    } else if (imiss === 6) {
      if (imisse > 0) {
        sprites.im_miss_e5.visible = false;
        sprites.im_miss_e6.visible = true;
      }
      if (imissw > 0) {
        sprites.im_miss_w5.visible = false;
        sprites.im_miss_w6.visible = true;
      }
      playSound('Miss');
    } else if (imiss === 7) {
      setTimerEnabled('miss_long', false);
      setTimerEnabled('show_miss', false);
      hide_miss();
      put_misses(imismatch);

      if (imismatch < 6) {
        if (bgame === 1) imode = 4;
        else if (bgame === 2) imode = 5;
        start_timers();
      } else {
        imode = 8;
        igameover = 0;
        if (bgame === 1 && iscore > ihiscorea) {
          ihiscorea = iscore;
          localStorage.setItem('gw_mickey_hi_a', String(ihiscorea));
        }
        if (bgame === 2 && iscore > ihiscoreb) {
          ihiscoreb = iscore;
          localStorage.setItem('gw_mickey_hi_b', String(ihiscoreb));
        }
        setTimerEnabled('game_over', true);
      }
    }
    updateUIStatus();
  }

  function onTimerMissShort() {
    imiss++;
    if (imiss === 1) {
      if (bchance) {
        bchance = false;
        setTimerEnabled('chance', false);
      }
      put_misses(imismatch);
      if (imisse > 0) sprites.im_miss_e1.visible = true;
      if (imissw > 0) sprites.im_miss_w1.visible = true;
      playSound('Miss');
    } else if (imiss === 2) {
      if (imisse > 0) sprites.im_miss_e1.visible = false;
      if (imissw > 0) sprites.im_miss_w1.visible = false;

      if (imismatch < 6) {
        if (imisse > 0) sprites.im_miss_e2.visible = true;
        if (imissw > 0) sprites.im_miss_w2.visible = true;
        playSound('Miss');
      } else {
        setTimerEnabled('miss_short', false);
        imode = 8;
        igameover = 0;
        if (bgame === 1 && iscore > ihiscorea) {
          ihiscorea = iscore;
          localStorage.setItem('gw_mickey_hi_a', String(ihiscorea));
        }
        if (bgame === 2 && iscore > ihiscoreb) {
          ihiscoreb = iscore;
          localStorage.setItem('gw_mickey_hi_b', String(ihiscoreb));
        }
        setTimerEnabled('game_over', true);
      }
    } else if (imiss === 3) {
      setTimerEnabled('miss_short', false);
      hide_miss();
      if (bgame === 1) imode = 4;
      else if (bgame === 2) imode = 5;
      start_timers();
    }
    updateUIStatus();
  }

  function onTimerObserver() {
    iobserver++;
    if (iobserver === 1) {
      sprites.im_panel_alarm_1.visible = true;
    } else if (iobserver === 6) {
      sprites.im_panel_alarm_1.visible = false;
    } else if (iobserver === 10) {
      iobserver = 0;
    }
    updateUIStatus();
  }

  function onTimerPoint() {
    ibonus--;
    playSound('Point');
    if (ibonus === 0) {
      setTimerEnabled('point', false);
    }
  }

  function onTimerShowMiss() {
    const idx = Math.floor((imismatch + 1) / 2);
    if (idx === 1) {
      sprites.im_panel_miss_1.visible = !sprites.im_panel_miss_1.visible;
    } else if (idx === 2) {
      sprites.im_panel_miss_1.visible = true;
      sprites.im_panel_miss_2.visible = !sprites.im_panel_miss_2.visible;
    } else if (idx === 3) {
      sprites.im_panel_miss_1.visible = true;
      sprites.im_panel_miss_2.visible = true;
      sprites.im_panel_miss_3.visible = !sprites.im_panel_miss_3.visible;
    }
  }

  function onTimerGame() {
    let bsound = false;
    istep = (istep + 1) % 5;

    let limit = iscore + 10;
    if (imode === 2) limit = 25;

    let imax = 3;
    if (limit > 10) imax = 4;
    if (limit > 30) imax = 5;
    if (limit > 60) imax = 6;
    if (limit > 90) imax = 7;

    let rIdx = istep - 1; // istep 1..4 -> rally 0..3

    if (istep >= 1 && istep <= 4) {
      if (benemy[rIdx][5]) {
        benemy[rIdx][5] = false;
        if (ihero === istep) {
          if (imode === 4 || imode === 5) {
            setTimerEnabled('point', true);
            if (!bchance) {
              iscore = (iscore + 1) % 10000;
              ibonus = 1;
            } else {
              iscore = (iscore + 2) % 10000;
              ibonus = 2;
              ichance--;
              if (ichance <= 0) {
                bchance = false;
                setTimerEnabled('chance', false);
                put_misses(imismatch);
              }
            }
            put_score(iscore);
            check_20_points();
            check_100_points();
            set_speed(iscore, bchance);
            bsound = false;
          }
        } else {
          // Missed egg!
          imiss = 0;
          if (istep === 1 || istep === 3) {
            imissw = 1;
            imisse = 0;
          } else {
            imisse = 1;
            imissw = 0;
          }
          stop_timers();
          if (sprites.im_panel_alarm_1.visible) {
            imismatch += 1;
            imode = 7;
            setTimerEnabled('miss_long', true);
          } else {
            imismatch += 2;
            imode = 6;
            setTimerEnabled('miss_short', true);
          }
          bsound = false;
        }
      }

      if (imode === 2 || imode === 4 || imode === 5) {
        if (count_enemies_in_rally(rIdx) > 0) {
          bsound = true;
        }
      }

      for (let i = 5; i >= 2; i--) {
        benemy[rIdx][i] = benemy[rIdx][i - 1];
      }
      benemy[rIdx][1] = false;
    } else if (istep === 0) {
      let total = count_enemies_total();
      let tries = 0;
      while (total < imax && tries < 25) {
        tries++;
        const i = Math.floor(Math.random() * 4);
        if (
          !benemy[i][1] &&
          !benemy[i][2] &&
          count_enemies_in_rally(i) < 2 &&
          i + 1 !== inorally
        ) {
          benemy[i][1] = true;
          total++;
          if (Math.floor(Math.random() * 3) !== 0) break;
        }
      }
      // Guarantee at least one egg spawns when empty
      if (count_enemies_total() === 0) {
        for (let i = 0; i < 4; i++) {
          if (i + 1 !== inorally) {
            benemy[i][1] = true;
            break;
          }
        }
      }
    }

    merge_enemies();

    if (bsound && !timers.point.enabled && (imode === 4 || imode === 5)) {
      if (istep === 1) playSound('Move_nw');
      else if (istep === 2) playSound('Move_ne');
      else if (istep === 3) playSound('Move_sw');
      else if (istep === 4) playSound('Move_se');
    }
    updateUIStatus();
  }

  // Button Press & Release Handlers (1:1 port of unit1.lua)
  function pressMove(dir) {
    ensureAudioContext();
    const downKey =
      dir === 1
        ? 'btn_1_nw_down'
        : dir === 2
        ? 'btn_2_ne_down'
        : dir === 3
        ? 'btn_3_sw_down'
        : 'btn_4_se_down';
    sprites[downKey].visible = true;

    if (imode === 1) {
      // Setting Clock Time (after ACL) or Alarm Time (after ALARM)
      hide_screen();
      put_hero(4);
      sprites.im_panel_time_colon.visible = true;
      if (settingTarget === 'clock') {
        if (dir === 1 || dir === 3) {
          ihora = (ihora + 1) % 24;
        } else {
          imin = (imin + 1) % 60;
        }
        isec = 0;
        put_time(ihora, imin);
      } else {
        sprites.im_panel_alarm_1.visible = true;
        if (dir === 1 || dir === 3) {
          ihoraa = (ihoraa + 1) % 24;
        } else {
          imina = (imina + 1) % 60;
        }
        put_time(ihoraa, imina);
      }
      playSound('Move_nw');
      updateUIStatus();
    } else if (imode === 4 || imode === 5) {
      ihero = dir;
      put_hero(ihero);
    }
  }

  function releaseMove(dir) {
    const downKey =
      dir === 1
        ? 'btn_1_nw_down'
        : dir === 2
        ? 'btn_2_ne_down'
        : dir === 3
        ? 'btn_3_sw_down'
        : 'btn_4_se_down';
    sprites[downKey].visible = false;
  }

  function pressGameA() {
    ensureAudioContext();
    sprites.btn_game_a_down.visible = true;
    if (imode === 1 || imode === 2 || imode === 8) {
      stop_timers();
      hide_screen();
      put_hero(ihero);
      bgame = 1;
      imode = 3;
      sprites.im_panel_game_a.visible = true;
      put_score(ihiscorea);
      updateUIStatus();
    }
  }

  function releaseGameA() {
    if (sprites.btn_game_a_down.visible) {
      sprites.btn_game_a_down.visible = false;
      if (imode === 3) {
        imode = 4;
        iscore = 0;
        put_score(iscore);
        set_speed(iscore, false);
        imismatch = 0;
        put_misses(imismatch);
        bchance = false;
        for (let i = 0; i < 4; i++) {
          for (let j = 1; j <= 5; j++) benemy[i][j] = false;
        }
        merge_enemies();
        iobserver = 0;
        check_20_points();
        start_timers();
        updateUIStatus();
      }
    }
  }

  function pressGameB() {
    ensureAudioContext();
    sprites.btn_game_b_down.visible = true;
    if (imode === 1 || imode === 2 || imode === 8) {
      stop_timers();
      hide_screen();
      put_hero(ihero);
      bgame = 2;
      imode = 3;
      sprites.im_panel_game_b.visible = true;
      put_score(ihiscoreb);
      updateUIStatus();
    }
  }

  function releaseGameB() {
    if (sprites.btn_game_b_down.visible) {
      sprites.btn_game_b_down.visible = false;
      if (imode === 3) {
        imode = 5;
        iscore = 0;
        put_score(iscore);
        set_speed(iscore, false);
        imismatch = 0;
        put_misses(imismatch);
        bchance = false;
        for (let i = 0; i < 4; i++) {
          for (let j = 1; j <= 5; j++) benemy[i][j] = false;
        }
        merge_enemies();
        iobserver = 0;
        inorally = 0;
        start_timers();
        updateUIStatus();
      }
    }
  }

  function pressTime() {
    ensureAudioContext();
    sprites.btn_time_down.visible = true;
    if (imode === 1) {
      imode = 2;
      hide_screen();
      put_hero(4);
      put_time(ihora, imin);
      sprites.im_panel_time_colon.visible = true;
      for (let i = 0; i < 4; i++) {
        for (let j = 1; j <= 5; j++) benemy[i][j] = false;
      }
      merge_enemies();
    } else if (imode === 2) {
      put_score(ihiscorea);
      sprites.im_panel_game_a.visible = true;
      setTimerEnabled('clock', false);
    } else if (imode === 8) {
      imode = 2;
      hide_enemies();
      hide_miss();
      put_misses(0);
      sprites.im_panel_game_a.visible = false;
      sprites.im_panel_game_b.visible = false;
      sprites.im_panel_alarm_1.visible = false;
      put_time(ihora, imin);
      sprites.im_panel_time_colon.visible = true;
    }
    updateUIStatus();
  }

  function releaseTime() {
    if (sprites.btn_time_down.visible) {
      sprites.btn_time_down.visible = false;
      if (imode === 2) {
        sprites.im_panel_game_a.visible = false;
        put_time(ihora, imin);
        sprites.im_panel_time_colon.visible = true;
        setTimerEnabled('clock', true);
      }
      updateUIStatus();
    }
  }

  function pressAlarm() {
    ensureAudioContext();
    sprites.btn_alarm_down.visible = true;
    if (imode === 1 || imode === 2) {
      imode = 1;
      settingTarget = 'alarm';
      stop_timers();
      hide_screen();
      put_hero(4);
      sprites.im_panel_alarm_1.visible = true;
      sprites.im_panel_time_colon.visible = true;
      put_time(ihoraa, imina);
      updateUIStatus();
    }
  }

  function releaseAlarm() {
    sprites.btn_alarm_down.visible = false;
  }

  function pressACL() {
    ensureAudioContext();
    sprites.btn_acl_down.visible = true;
    stop_timers();
    hide_screen();
    imode = 0;
    updateUIStatus();
  }

  function releaseACL() {
    if (sprites.btn_acl_down.visible) {
      sprites.btn_acl_down.visible = false;
      if (imode === 0) {
        imode = 1;
        settingTarget = 'clock';
        show_screen();
        updateUIStatus();
      }
    }
  }

  // Render Loop (60fps Canvas with Authentic LCD Ghosting & Shadows)
  function render() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // 1. Draw Console Background
    const bgImg = imgMap.im_background;
    if (bgImg) {
      ctx.drawImage(bgImg, 0, 0);
    }

    // 2. Draw Subtle Unlit LCD Ghost Segments (Authentic 1981 reflective LCD look)
    if (ghostOpacity > 0) {
      ctx.save();
      ctx.globalAlpha = ghostOpacity;
      lcdSpriteKeys.forEach((k) => {
        const s = sprites[k];
        if (s && !s.visible && imgMap[s.img]) {
          ctx.drawImage(imgMap[s.img], s.left, s.top);
        }
      });
      // Ghost 7-segment digits ('1' on digit 1, '8' on digits 2..4)
      const d1 = digits.im_panel_digit_1;
      if (!d1.visible && imgMap.im_number_1_1) {
        ctx.drawImage(imgMap.im_number_1_1, d1.left, d1.top);
      }
      const d2 = digits.im_panel_digit_2;
      if (!d2.visible && imgMap.im_number_2_8) {
        ctx.drawImage(imgMap.im_number_2_8, d2.left, d2.top);
      }
      const d3 = digits.im_panel_digit_3;
      if (!d3.visible && imgMap.im_number_3_8) {
        ctx.drawImage(imgMap.im_number_3_8, d3.left, d3.top);
      }
      const d4 = digits.im_panel_digit_4;
      if (!d4.visible && imgMap.im_number_4_8) {
        ctx.drawImage(imgMap.im_number_4_8, d4.left, d4.top);
      }
      ctx.restore();
    }

    // 3. Draw Active Sprites (Buttons + Active LCD Segments)
    Object.keys(sprites).forEach((k) => {
      if (k === 'im_background' || k.startsWith('im_number_')) return;
      const s = sprites[k];
      if (s && s.visible && imgMap[s.img]) {
        ctx.drawImage(imgMap[s.img], s.left, s.top);
      }
    });

    // 4. Draw Active Score / Clock Digits
    Object.keys(digits).forEach((k) => {
      const d = digits[k];
      if (d && d.visible && d.img && imgMap[d.img]) {
        ctx.drawImage(imgMap[d.img], d.left, d.top);
      }
    });

    requestAnimationFrame(render);
  }

  // Update external HUD status bar
  function updateUIStatus() {
    const modeEl = document.getElementById('status-mode');
    const scoreEl = document.getElementById('status-score');
    const hiAEl = document.getElementById('status-hia');
    const hiBEl = document.getElementById('status-hib');
    if (!modeEl) return;

    const modeNames = {
      0: 'ACL',
      1: 'Ajuste',
      2: 'Relógio',
      3: bgame === 1 ? 'Game A' : 'Game B',
      4: bchance ? 'Game A (x2!)' : 'Game A',
      5: bchance ? 'Game B (x2!)' : 'Game B',
      6: 'Miss!',
      7: '1/2 Miss!',
      8: 'Game Over'
    };
    modeEl.textContent = modeNames[imode] || 'Pronto';
    scoreEl.textContent = String(iscore);
    hiAEl.textContent = String(ihiscorea);
    hiBEl.textContent = String(ihiscoreb);
  }

  // Setup Interactive Overlay Hitboxes over the Console Canvas
  function setupHotspots() {
    const overlay = document.getElementById('hotspots-layer');
    const W = 654;
    const H = 396;

    const defs = [
      {
        id: 'hs-nw',
        left: 34,
        top: 230,
        width: 84,
        height: 72,
        label: '↖ Sup. Esq. (Q / 7)',
        down: () => pressMove(1),
        up: () => releaseMove(1)
      },
      {
        id: 'hs-sw',
        left: 34,
        top: 302,
        width: 84,
        height: 72,
        label: '↙ Inf. Esq. (A / 1)',
        down: () => pressMove(3),
        up: () => releaseMove(3)
      },
      {
        id: 'hs-ne',
        left: 536,
        top: 230,
        width: 84,
        height: 72,
        label: '↗ Sup. Dir. (P / 9)',
        down: () => pressMove(2),
        up: () => releaseMove(2)
      },
      {
        id: 'hs-se',
        left: 536,
        top: 300,
        width: 84,
        height: 72,
        label: '↘ Inf. Dir. (L / 3)',
        down: () => pressMove(4),
        up: () => releaseMove(4)
      },
      {
        id: 'hs-game-a',
        left: 544,
        top: 40,
        width: 48,
        height: 35,
        label: 'Iniciar GAME A (Tecla 1)',
        down: pressGameA,
        up: releaseGameA
      },
      {
        id: 'hs-game-b',
        left: 544,
        top: 90,
        width: 48,
        height: 35,
        label: 'Iniciar GAME B (Tecla 2)',
        down: pressGameB,
        up: releaseGameB
      },
      {
        id: 'hs-time',
        left: 544,
        top: 141,
        width: 48,
        height: 35,
        label: 'Modo Relógio TIME (Tecla 3)',
        down: pressTime,
        up: releaseTime
      },
      {
        id: 'hs-alarm',
        left: 601,
        top: 66,
        width: 24,
        height: 24,
        label: 'Ajustar Alarme (Tecla 4)',
        down: pressAlarm,
        up: releaseAlarm
      },
      {
        id: 'hs-acl',
        left: 601,
        top: 111,
        width: 24,
        height: 24,
        label: 'Reset ACL (Tecla 5)',
        down: pressACL,
        up: releaseACL
      }
    ];

    defs.forEach((d) => {
      const btn = document.createElement('button');
      btn.className = 'console-hotspot';
      btn.id = d.id;
      btn.title = d.label;
      btn.setAttribute('aria-label', d.label);
      btn.style.left = `${(d.left / W) * 100}%`;
      btn.style.top = `${(d.top / H) * 100}%`;
      btn.style.width = `${(d.width / W) * 100}%`;
      btn.style.height = `${(d.height / H) * 100}%`;

      const handleDown = (e) => {
        e.preventDefault();
        if (navigator.vibrate) navigator.vibrate(12);
        d.down();
      };
      const handleUp = (e) => {
        e.preventDefault();
        d.up();
      };

      btn.addEventListener('pointerdown', handleDown);
      btn.addEventListener('pointerup', handleUp);
      btn.addEventListener('pointerleave', handleUp);
      btn.addEventListener('pointercancel', handleUp);
      overlay.appendChild(btn);
    });
  }

  // Keyboard Controls
  function setupKeyboard() {
    const activeKeys = new Set();

    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      const code = e.code;
      const key = e.key.toLowerCase();

      // Prevent arrow key scrolling
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(code)) {
        e.preventDefault();
      }

      activeKeys.add(code);

      // Direct 4-corner keys: Q/A (left top/bottom), P/L or O/K or E/D (right top/bottom), Numpad 7/1/9/3
      if (key === 'q' || code === 'Numpad7') {
        pressMove(1);
      } else if (key === 'a' || key === 'z' || code === 'Numpad1') {
        pressMove(3);
      } else if (key === 'p' || key === 'o' || key === 'e' || code === 'Numpad9') {
        pressMove(2);
      } else if (key === 'l' || key === 'k' || key === 'd' || code === 'Numpad3') {
        pressMove(4);
      } else if (code === 'ArrowLeft') {
        // Move to left side keeping current vertical level
        pressMove(ihero === 3 || ihero === 4 ? 3 : 1);
      } else if (code === 'ArrowRight') {
        // Move to right side keeping current vertical level
        pressMove(ihero === 3 || ihero === 4 ? 4 : 2);
      } else if (code === 'ArrowUp') {
        // Move to top keeping current horizontal side
        pressMove(ihero === 2 || ihero === 4 ? 2 : 1);
      } else if (code === 'ArrowDown') {
        // Move to bottom keeping current horizontal side
        pressMove(ihero === 2 || ihero === 4 ? 4 : 3);
      } else if (key === '1') {
        pressGameA();
      } else if (key === '2') {
        pressGameB();
      } else if (key === '3') {
        pressTime();
      } else if (key === '4') {
        pressAlarm();
      } else if (key === '5' || key === 'r') {
        pressACL();
      }
    });

    window.addEventListener('keyup', (e) => {
      const code = e.code;
      const key = e.key.toLowerCase();
      activeKeys.delete(code);

      if (key === 'q' || code === 'Numpad7') {
        releaseMove(1);
      } else if (key === 'a' || key === 'z' || code === 'Numpad1') {
        releaseMove(3);
      } else if (key === 'p' || key === 'o' || key === 'e' || code === 'Numpad9') {
        releaseMove(2);
      } else if (key === 'l' || key === 'k' || key === 'd' || code === 'Numpad3') {
        releaseMove(4);
      } else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(code)) {
        releaseMove(1);
        releaseMove(2);
        releaseMove(3);
        releaseMove(4);
      } else if (key === '1') {
        releaseGameA();
      } else if (key === '2') {
        releaseGameB();
      } else if (key === '3') {
        releaseTime();
      } else if (key === '4') {
        releaseAlarm();
      } else if (key === '5' || key === 'r') {
        releaseACL();
      }
    });
  }

  // Toolbar Quick Controls
  function setupToolbar() {
    document.getElementById('btn-quick-a').addEventListener('click', () => {
      pressGameA();
      setTimeout(releaseGameA, 180);
    });
    document.getElementById('btn-quick-b').addEventListener('click', () => {
      pressGameB();
      setTimeout(releaseGameB, 180);
    });
    document.getElementById('btn-quick-time').addEventListener('click', () => {
      pressTime();
      setTimeout(releaseTime, 180);
    });
    document.getElementById('btn-quick-acl').addEventListener('click', () => {
      pressACL();
      setTimeout(releaseACL, 250);
    });

    const btnSound = document.getElementById('btn-toggle-sound');
    btnSound.addEventListener('click', () => {
      soundEnabled = !soundEnabled;
      btnSound.textContent = soundEnabled ? '🔊 Som' : '🔇 Mudo';
      btnSound.classList.toggle('active', soundEnabled);
    });

    const btnGhost = document.getElementById('btn-toggle-ghost');
    btnGhost.addEventListener('click', () => {
      if (ghostOpacity > 0) {
        ghostOpacity = 0;
        btnGhost.textContent = '🔲 LCD Off';
        btnGhost.classList.remove('active');
      } else {
        ghostOpacity = 0.055;
        btnGhost.textContent = '🔲 LCD';
        btnGhost.classList.add('active');
      }
    });

    const btnHints = document.getElementById('btn-toggle-hints');
    const overlay = document.getElementById('hotspots-layer');
    btnHints.addEventListener('click', () => {
      const showing = overlay.classList.toggle('show-hints');
      btnHints.classList.toggle('active', showing);
    });

    const btnKeys = document.getElementById('btn-toggle-keys');
    const keysPopover = document.getElementById('keys-popover');
    if (btnKeys && keysPopover) {
      btnKeys.addEventListener('click', () => {
        const isHidden = keysPopover.hasAttribute('hidden');
        if (isHidden) keysPopover.removeAttribute('hidden');
        else keysPopover.setAttribute('hidden', '');
        btnKeys.classList.toggle('active', isHidden);
      });
    }

    const btnFullscreen = document.getElementById('btn-fullscreen');
    btnFullscreen.addEventListener('click', async () => {
      const stage = document.getElementById('console-stage');
      try {
        if (!document.fullscreenElement) {
          const req = stage.requestFullscreen || stage.webkitRequestFullscreen;
          if (req) await req.call(stage);
          if (screen.orientation && screen.orientation.lock) {
            screen.orientation.lock('landscape').catch(() => {});
          }
        } else {
          await document.exitFullscreen();
        }
      } catch (_) {}
    });
  }

  // Boot & Preload
  function boot() {
    initData();
    setupHotspots();
    setupKeyboard();
    setupToolbar();

    // Preload fallback HTMLAudioElements
    Object.keys(ASSETS.sounds).forEach((k) => {
      const audio = new Audio('data:audio/wav;base64,' + ASSETS.sounds[k]);
      audio.preload = 'auto';
      fallbackAudio[k] = audio;
    });

    // Preload all 91 PNG images
    const keys = Object.keys(ASSETS.images);
    let loaded = 0;
    keys.forEach((k) => {
      const img = new Image();
      img.onload = () => {
        loaded++;
        if (loaded === keys.length) {
          startSimulator();
        }
      };
      img.src = ASSETS.images[k];
      imgMap[k] = img;
    });
  }

  function startSimulator() {
    // Start in Clock/Demo mode (imode = 2) so the LCD is alive immediately,
    // just like inserting LR43 batteries and pressing TIME!
    hide_screen();
    imode = 2;
    ihero = 4;
    put_hero(ihero);
    const now = new Date();
    ihora = now.getHours();
    imin = now.getMinutes();
    put_time(ihora, imin);
    sprites.im_panel_time_colon.visible = true;
    setTimerEnabled('clock', true);
    updateUIStatus();
    requestAnimationFrame(render);
  }

  window.addEventListener('DOMContentLoaded', boot);
})();
