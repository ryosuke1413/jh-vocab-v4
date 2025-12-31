const $ = (id) => document.getElementById(id);

const STORAGE_KEY = "jh_vocab_v4_state";
const AUTO_NEXT_MS = 1200;

const ROLLING_N = 50;
const MIN_HISTORY_FOR_RANK = 30;
const PROMOTE_ACC = 0.85;
const DEMOTE_ACC = 0.70;

const CLASS_RULES = [
  { name:"ビギナー", key:"beginner", min:1, max:2 },
  { name:"ブロンズ", key:"bronze", min:3, max:6 },
  { name:"シルバー", key:"silver", min:7, max:9 },
  { name:"ゴールド", key:"gold", min:10, max:12 },
  { name:"プラチナ", key:"platinum", min:13, max:14 },
  { name:"ダイヤモンド", key:"diamond", min:15, max:19 },
  { name:"レジェンド", key:"legend", min:20, max:30 },
  { name:"マスター", key:"master", min:31, max:Infinity },
];

function classForRank(rank){
  const r = Math.max(1, Number(rank)||1);
  return CLASS_RULES.find(c => r >= c.min && r <= c.max) || CLASS_RULES[0];
}
function suggestedLevelByRank(rank){
  const r = Math.max(1, Number(rank)||1);
  if(r >= 15) return 3;
  if(r >= 7) return 2;
  return 1;
}

const state = {
  words: [],
  byLevel: {1:[],2:[],3:[]},
  byLevelSeries: {1:new Map(),2:new Map(),3:new Map()},
  verbCandidates: {1:[],2:[],3:[]},
  session: null,
  profile: loadProfile(),
};

function loadProfile(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    if(!raw) return { rank: 1, rolling: [] };
    const p = JSON.parse(raw);
    if(!p || typeof p.rank !== "number" || !Array.isArray(p.rolling)) throw 0;
    p.rank = Math.max(1, p.rank|0);
    p.rolling = p.rolling.map(Boolean).slice(-ROLLING_N);
    return p;
  }catch{
    return { rank: 1, rolling: [] };
  }
}
function saveProfile(){ localStorage.setItem(STORAGE_KEY, JSON.stringify(state.profile)); }
function resetProfile(){
  localStorage.removeItem(STORAGE_KEY);
  state.profile = { rank: 1, rolling: [] };
  refreshUI();
}

function rollingAccuracy(){
  const arr = state.profile.rolling;
  if(arr.length === 0) return null;
  const ok = arr.filter(Boolean).length;
  return ok / arr.length;
}

function refreshUI(){
  const rank = state.profile.rank;

  $("rankText").textContent = String(rank);
  $("rankMiniValue").textContent = String(rank);
  $("rankAfterNum").textContent = String(rank);

  const cls = classForRank(rank);
  $("classText").textContent = cls.name;
  $("classMiniText").textContent = cls.name;
  $("classAfterText").textContent = cls.name;

  $("classBadge").className = "classBadge " + cls.key;
  $("classBadgeResult").className = "classBadge " + cls.key;

  const acc = rollingAccuracy();
  $("accText").textContent = acc === null ? "--%" : Math.round(acc*100) + "%";

  $("levelSel").value = String(suggestedLevelByRank(rank));
}

function normalize(s){ return String(s ?? "").trim().toLowerCase(); }
function shuffle(arr){
  for(let i=arr.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [arr[i],arr[j]]=[arr[j],arr[i]];
  }
  return arr;
}
function sample(arr){ return arr[Math.floor(Math.random()*arr.length)]; }

async function loadWords(){
  const res = await fetch("words.json", {cache:"no-cache"});
  if(!res.ok) throw new Error("words.json を読み込めませんでした");
  const data = await res.json();

  if(!Array.isArray(data)) throw new Error("words.json の形式が不正です（配列ではありません）");

  const cleaned = [];
  for(const w of data){
    if(!w || typeof w.en !== "string" || typeof w.ja !== "string") continue;
    const level = Number(w.level);
    if(!(level===1||level===2||level===3)) continue;
    const series = typeof w.series === "string" ? w.series : "名詞/その他";
    const entry = { en: w.en, ja: w.ja, level, series };
    if(w.forms && typeof w.forms.base==="string" && typeof w.forms.past==="string" && typeof w.forms.pp==="string"){
      entry.forms = { base: w.forms.base, past: w.forms.past, pp: w.forms.pp };
    }
    cleaned.push(entry);
  }

  state.words = cleaned;
  state.byLevel = {1:[],2:[],3:[]};
  state.byLevelSeries = {1:new Map(),2:new Map(),3:new Map()};
  state.verbCandidates = {1:[],2:[],3:[]};

  for(const w of cleaned){
    state.byLevel[w.level].push(w);
    const map = state.byLevelSeries[w.level];
    if(!map.has(w.series)) map.set(w.series, []);
    map.get(w.series).push(w);
    if(w.forms) state.verbCandidates[w.level].push(w);
  }

  refreshUI();
}

function show(id){
  $("home").classList.add("hidden");
  $("quiz").classList.add("hidden");
  $("result").classList.add("hidden");
  $(id).classList.remove("hidden");
}

function setQuizMeta(){
  const s = state.session;
  $("modeText").textContent = s.mode;
  $("levelText").textContent = "Lv" + s.level;
  $("progText").textContent = `${s.index+1} / ${s.total}`;
  $("scoreText").textContent = String(s.correct);
}

function setPrompt(main, sub=""){
  $("promptMain").textContent = main;
  $("promptSub").textContent = sub || " ";
}

function clearInteraction(){
  $("mcArea").innerHTML = "";
  $("mcArea").classList.add("hidden");
  $("typeArea").classList.add("hidden");
  $("feedback").classList.add("hidden");
  $("typeInput").value = "";
  $("typeInput").disabled = false;

  if(state.session && state.session.pendingAutoNext){
    clearTimeout(state.session.pendingAutoNext);
    state.session.pendingAutoNext = null;
  }
}

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, (m)=>({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[m]));
}
function showFeedback(isCorrect, big, small){
  const fb = $("feedback");
  fb.classList.remove("hidden","good","bad");
  fb.classList.add(isCorrect ? "good" : "bad");
  fb.innerHTML = `<div class="big">${escapeHtml(big)}</div><div class="small">${escapeHtml(small)}</div>`;
}

function showRankToast(newRank){
  $("rankToastSmall").textContent = `Rank ${newRank}`;
  const t = $("rankToast");
  t.classList.remove("hidden");
  setTimeout(()=>t.classList.add("hidden"), 2200);
}
function showClassToast(cls){
  const badge = $("classToastBadge");
  badge.textContent = cls.name;
  badge.className = "classToastBadge " + cls.key;
  const t = $("classToast");
  t.classList.remove("hidden");
  setTimeout(()=>t.classList.add("hidden"), 2400);
}

function pushRolling(isCorrect){
  state.profile.rolling.push(Boolean(isCorrect));
  if(state.profile.rolling.length > ROLLING_N){
    state.profile.rolling = state.profile.rolling.slice(-ROLLING_N);
  }
  saveProfile();
}

function applyRankRule(){
  const acc = rollingAccuracy();
  const n = state.profile.rolling.length;
  if(acc === null || n < MIN_HISTORY_FOR_RANK){
    return { note:`履歴 ${n}問（判定は${MIN_HISTORY_FOR_RANK}問以上）` };
  }

  const beforeRank = state.profile.rank;
  const beforeClass = classForRank(beforeRank);

  let afterRank = beforeRank;
  if(acc >= PROMOTE_ACC) afterRank = beforeRank + 1;
  else if(acc < DEMOTE_ACC) afterRank = Math.max(1, beforeRank - 1);

  state.profile.rank = afterRank;
  saveProfile();

  const afterClass = classForRank(afterRank);
  refreshUI();

  if(afterRank > beforeRank) showRankToast(afterRank);
  if(afterRank > beforeRank && afterClass.key !== beforeClass.key) showClassToast(afterClass);

  if(afterRank > beforeRank) return { note:`正答率 ${Math.round(acc*100)}% で昇格` };
  if(afterRank < beforeRank) return { note:`正答率 ${Math.round(acc*100)}% で降格` };
  return { note:`正答率 ${Math.round(acc*100)}%（維持）` };
}

/* unique selection */
function makeKeyForWord(w){ return normalize(w.en); }
function pickUniqueFrom(list, usedSet){
  for(let i=0;i<3000;i++){
    const w = sample(list);
    const key = makeKeyForWord(w);
    if(!usedSet.has(key)){
      usedSet.add(key);
      return w;
    }
  }
  for(const w of list){
    const key = makeKeyForWord(w);
    if(!usedSet.has(key)){
      usedSet.add(key);
      return w;
    }
  }
  return sample(list);
}

function startSession(){
  const level = Number($("levelSel").value);
  const dir = $("dirSel").value;
  const mode = $("modeSel").value;

  const plan = [];
  if(mode === "mix10"){
    for(let i=0;i<5;i++) plan.push({kind:"verbForm"});
    for(let i=0;i<5;i++) plan.push({kind:"seriesJa2En"});
    shuffle(plan);
  }else{
    for(let i=0;i<10;i++) plan.push({kind: mode==="mc10" ? "mc" : "type"});
  }

  state.session = {
    level, dir, mode,
    total: 10,
    index: 0,
    correct: 0,
    plan,
    history: [],
    current: null,
    answered: false,
    pendingAutoNext: null,
    usedAny: new Set(),
    usedVerbs: new Set(),
  };

  show("quiz");
  nextQuestion();
}

function pickWordUnique(level){ return pickUniqueFrom(state.byLevel[level], state.session.usedAny); }

function pickVerbUnique(level){
  const candidates = state.verbCandidates[level];
  if(candidates.length < 10) return null;

  for(let i=0;i<4000;i++){
    const w = sample(candidates);
    const base = normalize(w.forms.base);
    if(!state.session.usedVerbs.has(base)){
      state.session.usedVerbs.add(base);
      state.session.usedAny.add(normalize(w.en));
      return w;
    }
  }
  return sample(candidates);
}

function pickDistractors(level, correctWord, count, field){
  const list = state.byLevel[level];
  const used = new Set([normalize(correctWord[field])]);
  const out = [];
  let guard = 0;
  while(out.length < count && guard++ < 9000){
    const w = sample(list);
    const v = normalize(w[field]);
    if(!v || used.has(v)) continue;
    used.add(v);
    out.push(w[field]);
  }
  return out;
}

function makeMCQuestion(level, dir){
  const w = pickWordUnique(level);
  if(dir==="ja2en"){
    const correct = w.en;
    const wrongs = pickDistractors(level, w, 3, "en");
    const options = shuffle([correct, ...wrongs]);
    return { kind:"mc", promptMain:w.ja, promptSub:"日本語 → 英語（4択）", options, acceptAnswers:[correct], correctAnswer:correct, meta:{en:w.en,ja:w.ja,series:w.series} };
  }else{
    const correct = w.ja;
    const wrongs = pickDistractors(level, w, 3, "ja");
    const options = shuffle([correct, ...wrongs]);
    return { kind:"mc", promptMain:w.en, promptSub:"英語 → 日本語（4択）", options, acceptAnswers:[correct], correctAnswer:correct, meta:{en:w.en,ja:w.ja,series:w.series} };
  }
}

function makeTypeQuestion(level, dir){
  const w = pickWordUnique(level);
  if(dir==="ja2en"){
    return { kind:"type", promptMain:w.ja, promptSub:"日本語 → 英語（打ち込み）", acceptAnswers:[w.en], correctAnswer:w.en, meta:{en:w.en,ja:w.ja,series:w.series,forms:w.forms||null} };
  }else{
    return { kind:"type", promptMain:w.en, promptSub:"英語 → 日本語（打ち込み）", acceptAnswers:[w.ja], correctAnswer:w.ja, meta:{en:w.en,ja:w.ja,series:w.series,forms:w.forms||null} };
  }
}

function makeVerbFormQuestion(level){
  const w = pickVerbUnique(level);
  if(!w) return makeMCQuestion(level, "ja2en");

  const labels = { base:"現在形", past:"過去形", pp:"過去分詞" };
  const keys = ["base","past","pp"];
  const key = sample(keys);
  const shown = w.forms[key];
  const options = shuffle(keys.map(k=>labels[k]));
  const pastEqPp = normalize(w.forms.past) === normalize(w.forms.pp);

  let acceptLabels = [labels[key]];
  if(pastEqPp && (key==="past" || key==="pp")){
    acceptLabels = [labels.past, labels.pp];
  }

  return { kind:"verbForm", promptMain:`「${shown}」はどの形？`, promptSub:"動詞の形当て（4択）",
           options, acceptAnswers:acceptLabels, correctAnswer:labels[key],
           meta:{ja:w.ja,forms:w.forms,asked:key,pastEqPp} };
}

function makeSeriesJa2EnQuestion(level){
  const map = state.byLevelSeries[level];
  const seriesList = [...map.entries()].filter(([_,arr])=>arr.length>=8);
  if(seriesList.length===0) return makeMCQuestion(level, "ja2en");

  let seriesName, arr, w;
  for(let t=0;t<1000;t++){
    [seriesName, arr] = sample(seriesList);
    w = sample(arr);
    const key = normalize(w.en);
    if(!state.session.usedAny.has(key)){
      state.session.usedAny.add(key);
      break;
    }
    w = null;
  }
  if(!w){
    [seriesName, arr] = sample(seriesList);
    w = sample(arr);
    state.session.usedAny.add(normalize(w.en));
  }

  const correct = w.en;
  const all = state.byLevel[level];
  const used = new Set([normalize(correct)]);
  const wrongs = [];
  let guard=0;
  while(wrongs.length<3 && guard++<12000){
    const cand = sample(all);
    if(cand.series === seriesName) continue;
    const v = normalize(cand.en);
    if(!v || used.has(v)) continue;
    used.add(v);
    wrongs.push(cand.en);
  }
  const options = shuffle([correct, ...wrongs]);
  return { kind:"seriesJa2En", promptMain:`【${seriesName}】「${w.ja}」は英語で？`, promptSub:"系列（日→英 4択）",
           options, acceptAnswers:[correct], correctAnswer:correct, meta:{en:w.en,ja:w.ja,series:seriesName} };
}

function isAcceptedAnswer(your, acceptAnswers){
  const y = normalize(your);
  for(const a of (acceptAnswers || [])){
    if(normalize(a) === y) return true;
  }
  return false;
}

function renderChoices(options, acceptAnswers, canonicalCorrect){
  const area = $("mcArea");
  area.classList.remove("hidden");
  area.innerHTML = "";

  const acceptableSet = new Set((acceptAnswers||[]).map(a=>normalize(a)));

  options.forEach((opt)=>{
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "choice";
    btn.textContent = opt;

    btn.onclick = ()=>{
      if(state.session.answered) return;
      state.session.answered = true;

      const isCorrect = acceptableSet.has(normalize(opt));
      [...area.querySelectorAll("button")].forEach(b=>b.disabled=true);

      btn.classList.add(isCorrect ? "correct" : "wrong");

      // Show a correct option (canonical if it is acceptable, else first acceptable)
      let toMark = null;
      if(canonicalCorrect && acceptableSet.has(normalize(canonicalCorrect))){
        toMark = [...area.querySelectorAll("button")].find(b=>normalize(b.textContent)===normalize(canonicalCorrect));
      }
      if(!toMark){
        toMark = [...area.querySelectorAll("button")].find(b=>acceptableSet.has(normalize(b.textContent)));
      }
      if(toMark) toMark.classList.add("correct");

      onAnswered(isCorrect, opt);
    };

    area.appendChild(btn);
  });
}

function scheduleAutoNext(){
  const s = state.session;
  if(s.pendingAutoNext) clearTimeout(s.pendingAutoNext);
  s.pendingAutoNext = setTimeout(()=>{
    s.pendingAutoNext = null;
    s.index += 1;
    nextQuestion();
  }, AUTO_NEXT_MS);
}

function onAnswered(isCorrect, yourAnswer){
  const s = state.session;
  const q = s.current;

  if(isCorrect) s.correct += 1;
  setQuizMeta();
  pushRolling(isCorrect);

  if(isCorrect) showFeedback(true, "正解！", `答え：${q.correctAnswer}`);
  else showFeedback(false, "不正解", `答え：${q.correctAnswer}`);

  s.history.push({ kind:q.kind, promptMain:q.promptMain, meta:q.meta, correct:isCorrect, correctAnswer:q.correctAnswer, yourAnswer });

  scheduleAutoNext();
}

function nextQuestion(){
  const s = state.session;
  clearInteraction();

  if(s.index >= s.total){
    finishSession();
    return;
  }

  s.answered = false;
  setQuizMeta();

  const task = s.plan[s.index];
  let q;
  if(task.kind==="mc") q = makeMCQuestion(s.level, s.dir);
  else if(task.kind==="type") q = makeTypeQuestion(s.level, s.dir);
  else if(task.kind==="verbForm") q = makeVerbFormQuestion(s.level);
  else if(task.kind==="seriesJa2En") q = makeSeriesJa2EnQuestion(s.level);
  else q = makeMCQuestion(s.level, s.dir);

  s.current = q;
  setPrompt(q.promptMain, q.promptSub);

  if(q.kind==="type"){
    $("typeArea").classList.remove("hidden");
    $("typeInput").focus();
  }else{
    renderChoices(q.options, q.acceptAnswers, q.correctAnswer);
  }
}

function finishSession(){
  const info = applyRankRule();
  show("result");

  const s = state.session;
  $("resultScore").textContent = `${s.correct} / ${s.total}`;
  $("resultAcc").textContent = `正答率 ${Math.round((s.correct/s.total)*100)}%`;
  $("rankNote").textContent = info.note;

  const list = $("reviewList");
  list.innerHTML = "";
  for(const h of s.history){
    const div = document.createElement("div");
    div.className = "revItem";
    const tag = h.correct ? "✅" : "❌";
    const meta = h.meta || {};
    let extra = "";
    if(h.kind==="verbForm" && meta.forms){
      extra = `（base: ${meta.forms.base}, past: ${meta.forms.past}, pp: ${meta.forms.pp}）`;
      if(meta.pastEqPp) extra += "（past=pp）";
    }else{
      extra = `（${meta.en ?? ""} / ${meta.ja ?? ""} / ${meta.series ?? ""}）`;
    }
    div.innerHTML = `<b>${tag} ${escapeHtml(h.promptMain)}</b><div class="small">${escapeHtml("答え： " + h.correctAnswer + " " + extra)}</div>`;
    list.appendChild(div);
  }
}

function wire(){
  $("startBtn").onclick = startSession;
  $("quitBtn").onclick = ()=>show("home");
  $("backHomeBtn").onclick = ()=>show("home");
  $("retryBtn").onclick = ()=>startSession();

  $("typeArea").addEventListener("submit", (ev)=>{
    ev.preventDefault();
    const s = state.session;
    if(s.answered) return;
    s.answered = true;
    const q = s.current;
    const inp = $("typeInput");
    const your = inp.value.trim();
    inp.disabled = true;

    const correct = isAcceptedAnswer(your, q.acceptAnswers || [q.correctAnswer]);
    onAnswered(correct, your || "（未入力）");
  });

  $("resetBtn").onclick = ()=>{
    if(confirm("学習履歴（ランク・正答率履歴）をリセットします。よろしいですか？")){
      resetProfile();
      alert("リセットしました");
    }
  };

  refreshUI();
}

(async function main(){
  try{
    wire();
    await loadWords();
    show("home");
  }catch(e){
    console.error(e);
    alert(String(e?.message || e));
  }
})();
