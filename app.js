/* =========================================================
 * 背公式 · 层级学习 SPA
 * 结构：常量 → 日期工具 → AppState（数据/算法）→ 视图跳转 → UIRenderer → 控制器
 * 纯前端，无框架；KaTeX 可选，缺失时降级为纯文本
 * ========================================================= */

'use strict';

/* ---------------- 常量 ---------------- */

const DATA_URL = './docs/formulas.json';
const STORAGE_KEY = 'formula_app_state';
const STATE_VERSION = 1;

const MASTER_STAGE = 4;                        // 4 阶 = 已掌握，不再出现
const EASY_INTERVAL = { 1: 7, 2: 15, 3: 30 };  // 升到 1/2/3 阶的间隔天数
const FEEDBACK = { FORGOT: 'forgot', HARD: 'hard', EASY: 'easy' };

// 科目展示顺序（未列出的科目排在最后，按名称排序）
const SUBJECT_ORDER = ['高等数学', '线性代数', '概率论与数理统计', '附录：初等数学'];

// 科目图标
const SUBJECT_EMOJI = {
  '高等数学': '📐',
  '线性代数': '🧮',
  '概率论与数理统计': '🎲',
  '附录：初等数学': '📖',
};

/* ---------------- 日期工具 ---------------- */

function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function todayStr() {
  return formatDate(new Date());
}

/** 加 n 天：new Date 自动进位，跨月/跨年/闰年无需特判 */
function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return formatDate(new Date(y, m - 1, d + n));
}

/* =========================================================
 * AppState：数据、状态与调度算法（不碰 DOM）
 * ========================================================= */

const AppState = {
  records: [],      // 原始公式
  tree: [],         // [{ name, total, sections: [{ id, name, cards: [] }] }]
  cards: {},        // { [id]: { stage, nextReviewDate, lastReviewDate } }

  /** 读取 JSON + 合并本地状态 */
  async init() {
    const res = await fetch(DATA_URL, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const records = await res.json();
    if (!Array.isArray(records) || records.length === 0) throw new Error('formulas.json 为空');

    this.records = records;
    this.tree = this.buildTree(records);

    const today = todayStr();
    const stored = this.readState();
    this.cards = stored ? this.mergeState(stored, today) : this.buildInitialState(today);
    this.saveState();
  },

  /* ---- 层级树：科目 → 章节（保持数据原有顺序） ---- */
  buildTree(records) {
    const subjects = [];
    const subjectMap = new Map();

    for (const record of records) {
      const subjectName = (record['科目'] || '未分类').trim();
      const sectionName = (record['章节'] || '未分类').trim();

      let subject = subjectMap.get(subjectName);
      if (!subject) {
        subject = { name: subjectName, total: 0, sections: [], sectionMap: new Map() };
        subjectMap.set(subjectName, subject);
        subjects.push(subject);
      }
      subject.total += 1;

      let section = subject.sectionMap.get(sectionName);
      if (!section) {
        section = {
          id: `${subjectName}::${sectionName}`,
          name: sectionName,
          subject: subjectName,
          cards: [],
        };
        subject.sectionMap.set(sectionName, section);
        subject.sections.push(section);
      }
      section.cards.push(record);
    }

    // 科目排序：白名单优先，其余按名称
    const rank = (name) => {
      const i = SUBJECT_ORDER.indexOf(name);
      return i === -1 ? SUBJECT_ORDER.length : i;
    };
    subjects.sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));

    return subjects;
  },

  /* ---- localStorage ---- */
  readState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || typeof parsed.cards !== 'object') return null;
      return parsed;
    } catch (err) {
      console.warn('[state] 解析失败，重新初始化：', err);
      return null;
    }
  },

  saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        version: STATE_VERSION,
        cards: this.cards,
      }));
    } catch (err) {
      console.warn('[state] 写入失败：', err);
    }
  },

  /** 首次初始化：全部卡片 stage 0、今天到期、未复习（用“小节”限制单次量） */
  buildInitialState(today) {
    const cards = {};
    for (const record of this.records) {
      cards[record.id] = { stage: 0, nextReviewDate: today, lastReviewDate: null };
    }
    return cards;
  },

  /** 已有状态：按 id 与 JSON 合并，新增公式默认今天到期 */
  mergeState(stored, today) {
    const cards = {};
    for (const record of this.records) {
      const src = stored.cards[record.id];
      if (!src || typeof src !== 'object') {
        cards[record.id] = { stage: 0, nextReviewDate: today, lastReviewDate: null };
        continue;
      }
      let stage = Number(src.stage);
      if (!Number.isInteger(stage) || stage < 0) stage = 0;
      if (stage > MASTER_STAGE) stage = MASTER_STAGE;

      const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
      cards[record.id] = {
        stage,
        nextReviewDate: stage >= MASTER_STAGE ? null : (isDate(src.nextReviewDate) ? src.nextReviewDate : today),
        lastReviewDate: isDate(src.lastReviewDate) ? src.lastReviewDate : null,
      };
    }
    return cards;
  },

  /* ---- 是否“今日该复习” ---- */
  isDue(id, today) {
    const card = this.cards[id];
    if (!card) return false;
    if (card.stage >= MASTER_STAGE) return false;              // 已掌握
    if (!card.nextReviewDate || card.nextReviewDate > today) return false;
    if (card.lastReviewDate === today) return false;           // 今天已复习过
    return true;
  },

  /** 某个小节今日待复习的记录（保持数据顺序） */
  dueRecordsOfSection(section, today = todayStr()) {
    return section.cards.filter((record) => this.isDue(record.id, today));
  },

  /** 某个科目的今日待复习总数 */
  dueCountOfSubject(subject, today = todayStr()) {
    let count = 0;
    for (const section of subject.sections) count += this.dueRecordsOfSection(section, today).length;
    return count;
  },

  /** 全站今日待复习总数 */
  dueCountAll(today = todayStr()) {
    let count = 0;
    for (const subject of this.tree) count += this.dueCountOfSubject(subject, today);
    return count;
  },

  /**
   * 2-7-14 阶梯算法（纯函数）
   * forgot：stage=0，+1 天
   * hard  ：stage 不变，+3 天
   * easy  ：stage+1，1/2/3 阶分别 +7/+15/+30 天；到 4 阶视为掌握
   * 反馈后 lastReviewDate = 今天，当天不再入队
   */
  applyFeedback(id, feedback, today = todayStr()) {
    const current = this.cards[id];
    if (!current) return;
    const next = { ...current, lastReviewDate: today };

    if (feedback === FEEDBACK.FORGOT) {
      next.stage = 0;
      next.nextReviewDate = addDays(today, 1);
    } else if (feedback === FEEDBACK.HARD) {
      next.nextReviewDate = addDays(today, 3);
    } else if (feedback === FEEDBACK.EASY) {
      const stage = Math.min(current.stage + 1, MASTER_STAGE);
      next.stage = stage;
      next.nextReviewDate = stage >= MASTER_STAGE ? null : addDays(today, EASY_INTERVAL[stage]);
    }

    this.cards[id] = next;
    this.saveState();
  },
};

/* =========================================================
 * 视图跳转（左右滑动）
 * ========================================================= */

const View = {
  els: {},
  current: 'home',

  init() {
    this.els = {
      home: document.getElementById('view-home'),
      sections: document.getElementById('view-sections'),
      cards: document.getElementById('view-cards'),
    };
  },

  /**
   * direction: 'forward' 进（新页从右滑入，旧页向左退）
   *            'back'    退（新页从左滑入，旧页向右退出）
   */
  go(next, direction = 'forward') {
    if (next === this.current) return;
    const fromEl = this.els[this.current];
    const toEl = this.els[next];
    const forward = direction !== 'back';

    // 1) 无动画地把目标视图摆到起始位置
    toEl.classList.add('no-anim');
    toEl.classList.remove('is-active');
    toEl.classList.toggle('is-left', !forward);
    void toEl.offsetWidth; // 强制重排，确保起始状态生效
    toEl.classList.remove('no-anim');

    // 2) 旧视图滑出
    if (forward) {
      fromEl.classList.remove('is-active');
      fromEl.classList.add('is-left');
    } else {
      fromEl.classList.remove('is-active', 'is-left'); // 回到右侧
    }

    // 3) 新视图滑入
    toEl.classList.remove('is-left');
    toEl.classList.add('is-active');

    // 4) 重置滚动位置
    const scroller = toEl.querySelector('.scroll');
    if (scroller) scroller.scrollTop = 0;

    this.current = next;
  },
};

/* =========================================================
 * UIRenderer：只负责 DOM
 * ========================================================= */

const UIRenderer = {
  dom: {},
  session: null,       // { section, subject, list: [record], index }

  init() {
    this.dom = {
      homeDue: document.getElementById('home-due'),
      homeTotal: document.getElementById('home-total'),
      subjectList: document.getElementById('subject-list'),

      sectionsBack: document.getElementById('sections-back'),
      sectionsTitle: document.getElementById('sections-title'),
      sectionsSub: document.getElementById('sections-sub'),
      sectionList: document.getElementById('section-list'),

      cardsBack: document.getElementById('cards-back'),
      cardsTitle: document.getElementById('cards-title'),
      cardsSub: document.getElementById('cards-sub'),
      scene: document.getElementById('card-scene'),
      inner: document.getElementById('card-inner'),
      tag: document.getElementById('card-tag'),
      name: document.getElementById('card-name'),
      formula: document.getElementById('card-formula'),
      meta: document.getElementById('card-meta'),
      actions: document.getElementById('actions'),
      progress: document.getElementById('progress'),
      progressFill: document.getElementById('progress-fill'),
      progressText: document.getElementById('progress-text'),

      btnForgot: document.getElementById('btn-forgot'),
      btnHard: document.getElementById('btn-hard'),
      btnEasy: document.getElementById('btn-easy'),

      finishPanel: document.getElementById('finish-panel'),
      finishDesc: document.getElementById('finish-desc'),
      finishBack: document.getElementById('btn-finish-back'),

      toast: document.getElementById('toast'),
    };
  },

  /* ---- 视图 A ---- */
  renderHome() {
    const today = todayStr();
    this.dom.homeTotal.textContent = String(AppState.records.length);
    this.dom.homeDue.textContent = String(AppState.dueCountAll(today));

    const frag = document.createDocumentFragment();
    for (const subject of AppState.tree) {
      const due = AppState.dueCountOfSubject(subject, today);

      const btn = document.createElement('button');
      btn.className = 'subject-card';
      btn.type = 'button';

      const info = document.createElement('div');
      const name = document.createElement('div');
      name.className = 's-name';
      const emoji = SUBJECT_EMOJI[subject.name] || '📘';
      name.textContent = `${emoji} ${subject.name}`;

      const meta = document.createElement('div');
      meta.className = 's-meta';
      const dueSpan = document.createElement('span');
      dueSpan.textContent = '今日待复习 ';
      const dueNum = document.createElement('b');
      dueNum.textContent = String(due);
      dueSpan.appendChild(dueNum);
      const totalSpan = document.createElement('span');
      totalSpan.textContent = `共 ${subject.total} 张 · ${subject.sections.length} 个小节`;
      meta.append(dueSpan, totalSpan);

      info.append(name, meta);

      const chev = document.createElement('span');
      chev.className = 'chev';
      chev.textContent = '›';

      btn.append(info, chev);
      btn.addEventListener('click', () => Controller.openSubject(subject));
      frag.appendChild(btn);
    }

    this.dom.subjectList.textContent = '';
    this.dom.subjectList.appendChild(frag);
  },

  /* ---- 视图 B ---- */
  renderSections(subject) {
    const today = todayStr();
    const due = AppState.dueCountOfSubject(subject, today);

    this.dom.sectionsTitle.textContent = subject.name;
    this.dom.sectionsSub.textContent =
      `今日待复习 ${due} 张 · 共 ${subject.total} 张`;

    const frag = document.createDocumentFragment();
    for (const section of subject.sections) {
      const sectionDue = AppState.dueRecordsOfSection(section, today).length;

      const li = document.createElement('li');
      li.className = 'section-item';

      const top = document.createElement('div');
      top.className = 'section-top';

      const name = document.createElement('div');
      name.className = 'section-name';
      name.textContent = section.name;
      if (sectionDue === 0) name.classList.add('is-zero');

      const badge = document.createElement('span');
      badge.className = 'due-badge' + (sectionDue === 0 ? ' is-zero' : '');
      badge.textContent = sectionDue === 0 ? '已完成' : `${sectionDue} 张`;

      top.append(name, badge);

      const btn = document.createElement('button');
      btn.className = 'btn-review' + (sectionDue === 0 ? ' is-zero' : '');
      btn.type = 'button';
      btn.textContent = sectionDue === 0 ? '本单元今日已复习完毕' : '复习本单元';
      btn.addEventListener('click', () => Controller.startSection(subject, section));

      li.append(top, btn);
      frag.appendChild(li);
    }

    this.dom.sectionList.textContent = '';
    this.dom.sectionList.appendChild(frag);
  },

  /* ---- 视图 C ---- */
  /**
   * 进入某个小节：先算局部队列，空则提示，不进入卡片页。
   */
  startSection(subject, section) {
    const list = AppState.dueRecordsOfSection(section);
    if (list.length === 0) {
      this.toast('本单元今日已复习完毕');
      return;
    }

    this.session = { subject, section, list, index: 0 };
    this.dom.finishPanel.classList.add('hidden');
    this.dom.scene.classList.remove('hidden');
    this.dom.actions.classList.remove('hidden');
    this.dom.progress.classList.remove('hidden');
    this.setFeedbackEnabled(true);

    this.dom.cardsTitle.textContent = section.name;
    this.dom.cardsSub.textContent = subject.name;

    View.go('cards', 'forward');
    this.renderCurrentCard();
  },

  renderCurrentCard() {
    const session = this.session;
    if (!session) return;

    const record = session.list[session.index];
    this.renderCard(record);

    const total = session.list.length;
    this.dom.progressText.textContent = `${session.index + 1} / ${total}`;
    this.dom.progressFill.style.width = `${(session.index / total) * 100}%`;
  },

  renderCard(record) {
    const section = (record['章节'] || '').trim();
    const subject = (record['科目'] || '').trim();

    this.dom.tag.textContent = section ? `${subject} · ${section}` : subject;
    this.dom.tag.title = this.dom.tag.textContent;
    this.dom.name.textContent = record['公式名称'] || '（未命名公式）';
    this.renderFormula(record['latex']);
    this.renderMeta(record);

    // 每张新卡回到正面
    this.dom.inner.classList.remove('is-flipped');
  },

  /** KaTeX 优先，缺失/失败降级为纯文本 */
  renderFormula(latex) {
    const box = this.dom.formula;
    box.textContent = '';
    if (window.katex && typeof latex === 'string' && latex.trim()) {
      try {
        window.katex.render(latex, box, {
          displayMode: true,
          throwOnError: false,
          strict: 'ignore',
        });
        return;
      } catch (err) {
        console.warn('[katex] 渲染失败，降级为文本：', err);
      }
    }
    const pre = document.createElement('pre');
    pre.textContent = latex || '（无公式内容）';
    box.appendChild(pre);
  },

  /** 条件 / 备注为空时整块不渲染 */
  renderMeta(record) {
    const box = this.dom.meta;
    box.textContent = '';

    const rows = [
      { label: '条件', value: (record['条件'] || '').trim() },
      { label: '备注', value: (record['备注'] || '').trim() },
    ].filter((row) => row.value);

    for (const row of rows) {
      const wrap = document.createElement('div');
      wrap.className = 'row';
      const key = document.createElement('span');
      key.className = 'k';
      key.textContent = row.label;
      const text = document.createElement('span');
      text.textContent = row.value;
      wrap.append(key, text);
      box.appendChild(wrap);
    }
  },

  setFeedbackEnabled(enabled) {
    [this.dom.btnForgot, this.dom.btnHard, this.dom.btnEasy].forEach((btn) => {
      btn.disabled = !enabled;
    });
  },

  /** 当前卡收起，进入下一张或结算 */
  advance() {
    const session = this.session;
    if (!session) return;

    session.index += 1;
    if (session.index >= session.list.length) {
      this.showFinish();
      return;
    }
    this.renderCurrentCard();
    this.setFeedbackEnabled(true);
  },

  showFinish() {
    const total = this.session ? this.session.list.length : 0;
    this.dom.finishDesc.textContent = `本单元 ${total} 张卡片已全部复习，明天再来巩固。`;
    this.dom.scene.classList.add('hidden');
    this.dom.actions.classList.add('hidden');
    this.dom.progress.classList.add('hidden');
    this.dom.finishPanel.classList.remove('hidden');
    this.setFeedbackEnabled(false);
    this.session = null;
    this.dom.progressFill.style.width = '100%';
    this.dom.progressText.textContent = `${total} / ${total}`;
  },

  /** KaTeX 晚于首屏就绪时补渲染 */
  ensureFormulaRendered() {
    if (!this.session) return;
    if (window.katex && !this.dom.formula.querySelector('.katex')) {
      const record = this.session.list[this.session.index];
      if (record) this.renderFormula(record['latex']);
    }
  },

  toast(message) {
    const el = this.dom.toast;
    el.textContent = message;
    el.classList.add('is-show');
    window.clearTimeout(this._toastTimer);
    this._toastTimer = window.setTimeout(() => el.classList.remove('is-show'), 1800);
  },
};

/* =========================================================
 * Controller：交互编排
 * ========================================================= */

const Controller = {
  currentSubject: null,
  flipped: false,
  busy: false,

  openSubject(subject) {
    this.currentSubject = subject;
    UIRenderer.renderSections(subject);
    View.go('sections', 'forward');
  },

  backHome() {
    UIRenderer.renderHome(); // 回首页时刷新各科目今日数量
    View.go('home', 'back');
  },

  backToSections() {
    if (this.currentSubject) UIRenderer.renderSections(this.currentSubject);
    View.go('sections', 'back');
  },

  startSection(subject, section) {
    this.flipped = false;
    UIRenderer.dom.inner.classList.remove('is-flipped');
    UIRenderer.startSection(subject, section);
  },

  toggleFlip() {
    if (!UIRenderer.session) return;
    UIRenderer.ensureFormulaRendered();
    this.flipped = !this.flipped;
    UIRenderer.dom.inner.classList.toggle('is-flipped', this.flipped);
  },

  /** 点击反馈按钮：改状态 → 落盘 → 转回正面 → 300ms 后切下一张 */
  handleFeedback(feedback) {
    if (this.busy) return;
    const session = UIRenderer.session;
    if (!session) return;

    const record = session.list[session.index];
    this.busy = true;
    AppState.applyFeedback(record.id, feedback);
    UIRenderer.setFeedbackEnabled(false);

    UIRenderer.dom.inner.classList.remove('is-flipped');
    this.flipped = false;

    window.setTimeout(() => {
      UIRenderer.advance();
      this.busy = false;
    }, 300);
  },

  /** 安卓设备才展示安装入口 */
  isAndroid() {
    return /Android/i.test(navigator.userAgent);
  },

  /** 根据设备与 beforeinstallprompt 状态显示/隐藏安装按钮 */
  updateInstallButton() {
    const btn = document.getElementById('btn-install');
    if (!btn) return;
    const canInstall = this.isAndroid() && !!window.deferredPrompt;
    btn.classList.toggle('hidden', !canInstall);
  },

  /** 触发安卓安装弹窗；安装完成或取消后隐藏按钮 */
  async installApp() {
    const btn = document.getElementById('btn-install');
    const promptEvent = window.deferredPrompt;
    if (!promptEvent) return;
    try {
      promptEvent.prompt();
      await promptEvent.userChoice;
    } catch (err) {
      console.warn('[pwa] 安装弹窗异常：', err);
    } finally {
      window.deferredPrompt = null;
      if (btn) btn.classList.add('hidden');
    }
  },

  bind() {
    const d = UIRenderer.dom;

    d.inner.addEventListener('click', () => this.toggleFlip());
    d.btnForgot.addEventListener('click', () => this.handleFeedback(FEEDBACK.FORGOT));
    d.btnHard.addEventListener('click', () => this.handleFeedback(FEEDBACK.HARD));
    d.btnEasy.addEventListener('click', () => this.handleFeedback(FEEDBACK.EASY));

    document.getElementById('sections-back').addEventListener('click', () => this.backHome());
    document.getElementById('cards-back').addEventListener('click', () => {
      UIRenderer.session = null;
      this.backToSections();
    });
    d.finishBack.addEventListener('click', () => this.backToSections());

    const resetBtn = document.getElementById('btn-reset');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        if (!window.confirm('确定清空所有复习进度吗？此操作不可撤销。')) return;
        localStorage.removeItem(STORAGE_KEY);
        window.location.reload();
      });
    }

    // PWA 安装入口
    const installBtn = document.getElementById('btn-install');
    if (installBtn) installBtn.addEventListener('click', () => this.installApp());
    window.addEventListener('installpromptready', () => this.updateInstallButton());
    window.addEventListener('appinstalled', () => this.updateInstallButton());
  },

  async boot() {
    View.init();
    UIRenderer.init();
    this.bind();

    try {
      await AppState.init();
    } catch (err) {
      console.error('[boot] 初始化失败：', err);
      UIRenderer.dom.subjectList.textContent = '';
      UIRenderer.toast('数据加载失败，请用本地服务器打开页面');
      return;
    }

    UIRenderer.renderHome();
    this.updateInstallButton();
  },
};

document.addEventListener('DOMContentLoaded', () => Controller.boot());
window.addEventListener('load', () => UIRenderer.ensureFormulaRendered());
