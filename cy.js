/* 청약 일정 상태 계산 — 방문자의 오늘(한국 시간)을 기준으로 접수 중/예정/마감을 정한다.
   DOM을 건드리지 않는 순수 함수만 둔다 (Node에서 테스트 가능). window.APT_CY로 내보낸다. */
(function (root) {
  "use strict";

  var DAY = 86400000;
  var CUTOFF_MIN = 17 * 60 + 30;   // 청약홈 접수 마감은 보통 17:30
  var WD = ["일", "월", "화", "수", "목", "금", "토"];

  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function isoOf(d) { return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate()); }
  function toUTC(iso) { var p = iso.split("-"); return Date.UTC(+p[0], +p[1] - 1, +p[2]); }
  function diffDays(a, b) { return Math.round((toUTC(b) - toUTC(a)) / DAY); }   // b - a
  function addDays(iso, n) { return isoOf(new Date(toUTC(iso) + n * DAY)); }

  /* 한국은 일광절약시간이 없으므로 UTC+9를 그대로 더하면 정확하다. ?today=YYYY-MM-DD[THH:MM]은 테스트용. */
  function now(search, ms) {
    var m = /[?&]today=(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2}))?/.exec(search || "");
    if (m && !isNaN(toUTC(m[1]))) {
      var mins = m[2] ? (+m[2]) * 60 + (+m[3]) : 12 * 60;
      return { date: m[1], minutes: mins, cutoff: mins >= CUTOFF_MIN, override: true };
    }
    var k = new Date((ms == null ? Date.now() : ms) + 9 * 3600000);
    var minutes = k.getUTCHours() * 60 + k.getUTCMinutes();
    return { date: isoOf(k), minutes: minutes, cutoff: minutes >= CUTOFF_MIN, override: false };
  }

  function wd(iso) { return WD[new Date(toUTC(iso)).getUTCDay()]; }
  /* "2026-12-01" -> "12.1(화)" */
  function fmt(iso) {
    if (!iso) return "";
    var p = iso.split("-");
    return (+p[1]) + "." + (+p[2]) + "(" + wd(iso) + ")";
  }
  function fmtRange(s, e) {
    if (!s) return "";
    if (!e || e === s) return fmt(s);
    var ps = s.split("-"), pe = e.split("-");
    var end = ps[1] === pe[1] ? (+pe[2]) + "(" + wd(e) + ")" : fmt(e);
    return fmt(s) + "~" + end;
  }
  function dday(n) { return n === 0 ? "D-day" : (n > 0 ? "D-" + n : "D+" + (-n)); }

  var SHORT = { special: "특공", first: "1순위", second: "2순위", apply: "접수" };

  function windowsOf(item) { return Array.isArray(item.schedule) ? item.schedule : []; }
  function hasParseFail(item) {
    return (item.schedule_flags || []).some(function (f) { return /^parse_failed:(special|first|second|apply)$/.test(f); });
  }

  /* 상태 코드: open 지금 접수 중 · upcoming 접수 예정 · awaiting 접수 마감·발표 대기 · closed 마감 ·
     tbd 공고 예정(미확정) · check 일정 확인 필요 */
  var LABEL = {
    open: "지금 접수 중", upcoming: "접수 예정", awaiting: "발표 대기",
    closed: "마감", tbd: "공고 예정", check: "일정 확인 필요"
  };
  var ORDER = ["open", "upcoming", "check", "tbd", "awaiting", "closed"];
  var APPLICABLE = { open: true, upcoming: true, check: true };   // "신청 가능" = 접수 중·예정, 그리고 확인이 필요한 것(숨기는 쪽이 더 나쁜 실수)

  function statusOf(item, t) {
    var today = t.date;
    var floor = item.status === "마감";   // 손으로 '마감' 처리한 항목은 날짜가 남아 있어도 마감 (예: 1순위에서 마감되어 2순위 없음)
    var ws = windowsOf(item);
    function ended(w) { return floor || w.end < today || (w.end === today && t.cutoff); }
    var current = ws.filter(function (w) { return !ended(w) && w.start <= today; });
    var future = ws.filter(function (w) { return !ended(w) && w.start > today; });
    var past = ws.filter(ended);
    var r = { code: null, label: "", badge: "", current: current, next: null, dday: null, lastDay: false,
      past: past, sortKey: "9999-99-99" };

    if (hasParseFail(item) && !floor) {
      r.code = "check"; r.badge = "일정 확인 필요";
    } else if (current.length) {
      var soonest = current.reduce(function (a, b) { return a.end <= b.end ? a : b; });
      var left = diffDays(today, soonest.end);
      r.code = "open";
      r.lastDay = left === 0;
      r.badge = left === 0 ? "오늘 마감" : "마감 " + dday(left);
      r.dday = left;
      r.next = future[0] || null;
      r.sortKey = soonest.end;
    } else if (future.length) {
      r.code = "upcoming";
      r.next = future[0];
      r.dday = diffDays(today, future[0].start);
      r.badge = r.dday === 1 ? "내일 접수" : "접수 " + dday(r.dday);
      r.sortKey = future[0].start;
    } else if (ws.length && item.winners_end && today <= item.winners_end) {
      r.code = "awaiting";
      var wdays = item.winners_date ? diffDays(today, item.winners_date) : null;
      r.dday = wdays;
      r.badge = wdays == null ? "발표 대기" : (wdays <= 0 ? "오늘 발표" : "발표 " + dday(wdays));
      r.sortKey = item.winners_date || item.winners_end;
    } else if (ws.length) {
      r.code = "closed"; r.badge = "마감";
      r.sortKey = "~" + ws[ws.length - 1].end;   // 마감은 뒤로, 최근 것부터는 호출 쪽에서 정렬
    } else if (item.status === "예정(미확정)") {
      r.code = "tbd"; r.badge = "공고 전";
    } else if (item.status === "접수 중" || item.status === "공고됨") {
      r.code = "check"; r.badge = "일정 확인 필요";
    } else {
      r.code = "closed"; r.badge = "마감";
    }
    r.label = LABEL[r.code];
    r.applicable = !!APPLICABLE[r.code];
    return r;
  }

  /* 한눈에 보는 단계: 공고 → 특공 → 1순위 → 2순위 → 발표 → 계약 → 입주. 같은 종류 창은 하나로 묶는다. */
  function timeline(item, t) {
    var today = t.date, floor = item.status === "마감";
    var steps = [];
    function dayState(d) { return d < today ? "past" : (d === today ? "current" : "future"); }
    if (item.announce_date) steps.push({ key: "announce", label: "공고", start: item.announce_date, end: item.announce_date, state: dayState(item.announce_date) });
    var byKind = {};
    windowsOf(item).forEach(function (w) {
      var s = byKind[w.kind];
      if (!s) { s = byKind[w.kind] = { key: w.kind, label: SHORT[w.kind] || "접수", start: w.start, end: w.end, wins: [] }; steps.push(s); }
      s.start = s.start < w.start ? s.start : w.start;
      s.end = s.end > w.end ? s.end : w.end;
      s.wins.push(w);
    });
    steps.forEach(function (s) {
      if (!s.wins) return;
      var st = s.wins.map(function (w) {
        if (floor || w.end < today || (w.end === today && t.cutoff)) return "past";
        return w.start <= today ? "current" : "future";
      });
      s.state = st.indexOf("current") >= 0 ? "current" : (st.every(function (x) { return x === "past"; }) ? "past" : "future");
      delete s.wins;
    });
    if (item.winners_date) {
      var we = item.winners_end || item.winners_date;
      steps.push({ key: "winners", label: "발표", start: item.winners_date, end: we,
        state: we < today ? "past" : (item.winners_date <= today ? "current" : "future") });
    }
    if (item.contract) {
      var c = item.contract;
      steps.push({ key: "contract", label: "계약", start: c.start, end: c.end,
        state: c.end < today ? "past" : (c.start <= today ? "current" : "future") });
    }
    if (item.move_in_month) {
      var mm = today.slice(0, 7);
      steps.push({ key: "move_in", label: "입주", start: item.move_in_month, end: item.move_in_month, month: true,
        state: item.move_in_month < mm ? "past" : (item.move_in_month === mm ? "current" : "future") });
    }
    steps.sort(function (a, b) { return a.start < b.start ? -1 : a.start > b.start ? 1 : 0; });
    return steps;
  }

  /* 상세 일정 목록: 공고, 접수 창 하나하나(해당·기타지역 따로), 발표, 계약, 입주 */
  function rows(item, t) {
    var today = t.date, floor = item.status === "마감", out = [];
    function st(s, e, win) {
      if (win && (floor || e < today || (e === today && t.cutoff))) return "past";
      if (!win && e < today) return "past";
      return s <= today ? "current" : "future";
    }
    if (item.announce_date) out.push({ label: "모집 공고", start: item.announce_date, end: item.announce_date, state: st(item.announce_date, item.announce_date) });
    windowsOf(item).forEach(function (w) {
      out.push({ label: w.label, kind: w.kind, start: w.start, end: w.end, window: true,
        note: w.kind === "second" ? "1순위에서 마감되면 접수하지 않음" : null, state: st(w.start, w.end, true) });
    });
    if (item.winners_date) {
      var we = item.winners_end || item.winners_date;
      out.push({ label: "당첨자 발표", start: item.winners_date, end: we, state: st(item.winners_date, we) });
    }
    if (item.contract) out.push({ label: "계약", start: item.contract.start, end: item.contract.end, state: st(item.contract.start, item.contract.end) });
    if (item.move_in_month) {
      var mm = today.slice(0, 7);
      out.push({ label: "입주 예정", start: item.move_in_month, end: item.move_in_month, month: true,
        raw: (item.dates || {}).move_in || item.move_in_month,
        state: item.move_in_month < mm ? "past" : (item.move_in_month === mm ? "current" : "future") });
    }
    out.sort(function (a, b) { return a.start < b.start ? -1 : a.start > b.start ? 1 : 0; });
    return out;
  }

  function age(meta, t) {
    var asOf = meta && meta.as_of;
    if (!asOf) return null;
    return Math.max(0, diffDays(asOf, t.date));
  }

  /* 오늘부터 6일 뒤까지의 접수 일정 (시작·마지막 날) */
  function week(items, t) {
    var from = t.date, to = addDays(t.date, 6), out = [];
    items.forEach(function (it) {
      var st = statusOf(it, t);
      if (st.code === "closed" || st.code === "tbd") return;
      windowsOf(it).forEach(function (w) {
        if (it.status === "마감") return;
        if (w.end === from && t.cutoff) return;
        if (w.start >= from && w.start <= to && w.start !== w.end) out.push({ date: w.start, item: it, what: w.label + " 시작" });
        if (w.end >= from && w.end <= to) out.push({ date: w.end, item: it, what: w.start === w.end ? w.label : w.label + " 마지막 날" });
      });
    });
    out.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
    return out;
  }

  /* ---- 캘린더 파일 (.ics). 공개된 공고 정보만 담는다. */
  function icsEscape(s) { return String(s).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n"); }
  function utf8Len(ch) { var c = ch.codePointAt(0); return c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4; }
  function fold(line) {
    var out = [], cur = "", n = 0, limit = 75;
    Array.from(line).forEach(function (ch) {
      var b = utf8Len(ch);
      if (n + b > limit) { out.push(cur); cur = " "; n = 1; limit = 75; }
      cur += ch; n += b;
    });
    out.push(cur);
    return out.join("\r\n");
  }
  function ymd(iso) { return iso.replace(/-/g, ""); }
  function ics(item, t, ms) {
    var stamp = new Date(ms == null ? Date.now() : ms).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    var events = [];
    var floor = item.status === "마감";
    windowsOf(item).forEach(function (w) {
      if (floor || w.end < t.date) return;
      events.push({ uid: w.kind + "-" + w.start + (w.region ? "-" + w.region : ""), s: w.start, e: w.end,
        title: "[청약] " + item.name + " · " + w.label + (w.kind === "second" ? " (1순위 마감 시 없음)" : "") });
    });
    if (item.winners_date && item.winners_date >= t.date) events.push({ uid: "winners-" + item.winners_date, s: item.winners_date, e: item.winners_date, title: "[청약] " + item.name + " · 당첨자 발표" });
    if (item.contract && item.contract.end >= t.date) events.push({ uid: "contract-" + item.contract.start, s: item.contract.start, e: item.contract.end, title: "[청약] " + item.name + " · 계약" });
    var desc = (item.sgg_label || "") + (item.type ? " · " + item.type : "") +
      "\n접수 시간·자격은 입주자모집공고문으로 확인하세요." + (item.source && item.source.url ? "\n" + item.source.url : "");
    var lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//apt-map//cheongyak//KO", "CALSCALE:GREGORIAN", "METHOD:PUBLISH"];
    events.forEach(function (ev) {
      lines.push("BEGIN:VEVENT",
        "UID:" + item.id + "-" + ev.uid + "@apt-map",
        "DTSTAMP:" + stamp,
        "DTSTART;VALUE=DATE:" + ymd(ev.s),
        "DTEND;VALUE=DATE:" + ymd(addDays(ev.e, 1)),
        "SUMMARY:" + icsEscape(ev.title),
        "DESCRIPTION:" + icsEscape(desc),
        "TRANSP:TRANSPARENT",
        "BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:PT9H", "DESCRIPTION:" + icsEscape(ev.title), "END:VALARM",
        "END:VEVENT");
    });
    lines.push("END:VCALENDAR");
    return { text: lines.map(fold).join("\r\n") + "\r\n", count: events.length };
  }

  root.APT_CY = {
    now: now, statusOf: statusOf, timeline: timeline, rows: rows, age: age, week: week, ics: ics,
    fmt: fmt, fmtRange: fmtRange, dday: dday, diffDays: diffDays, addDays: addDays,
    LABEL: LABEL, ORDER: ORDER, SHORT: SHORT, APPLICABLE: APPLICABLE, CUTOFF_TEXT: "17:30"
  };
})(typeof window !== "undefined" ? window : globalThis);
