// 🛠️ 你的新專案雲端連線資訊已完全就位
const SUPABASE_URL = "https://xlolhgdoygwngdpyicxa.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_1AX5Eh2XizCebLDPjvtp8g_N-ITWIKw";

// 初始化 Supabase 客戶端
const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ==========================================================================
// 🛠️ 基礎工具函式（宣告於最上方，確保全域調用不報錯）
// ==========================================================================

function toDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function formatDate(dateKey) {
  if (!dateKey || typeof dateKey !== "string" || !dateKey.includes("-")) return "未設定";
  const parts = dateKey.split("-");
  if (parts.length !== 3) return "未設定";
  return `${parts[0]}/${parts[1]}/${parts[2]}`;
}

// 🎯 新增：將 Supabase 的時間戳記轉化為帶有「時:分」的親切格式
function formatPrecisionTime(createdAtString, dateKey) {
  if (!createdAtString) return formatDate(dateKey);
  try {
    const dateObj = new Date(createdAtString);
    const timePart = dateObj.toLocaleTimeString('zh-TW', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
    
    // 如果是今天的信，就顯示「今天 22:30」，否則顯示「2026/06/17 22:30」
    if (dateKey === todayKey) {
      return `今天 ${timePart}`;
    } else {
      return `${formatDate(dateKey)} ${timePart}`;
    }
  } catch (e) {
    return formatDate(dateKey);
  }
}

function clearTimers() {
  if (roomTimer) window.clearTimeout(roomTimer);
  if (reminderTimer) window.clearTimeout(reminderTimer);
  if (characterTimer) window.clearTimeout(characterTimer);
  roomTimer = null;
  reminderTimer = null;
  characterTimer = null;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

const TODAY = new Date();
const todayKey = toDateKey(TODAY);
const app = document.querySelector("#app");

// 📊 全局數據狀態管理
let state = {
  user: null,           
  activeDiary: null,    
  letters: [],          
  partner: null,        
  hasShowedTutorial: false
};

let roomTimer = null;
let reminderTimer = null;
let characterTimer = null;
let pendingReminder = false;

const spots = {
  door:      { x: 148, y: 535, action: "walking",  z: 4 },   
  desk:      { x: 310, y: 550, action: "writing",  z: 4 },   
  bookshelf: { x: 480, y: 535, action: "reading",  z: 4 },   
  center:    { x: 580, y: 560, action: "",         z: 4 },   
  bed:       { x: 745, y: 510, action: "sleeping", z: 2 }    
};

// ==========================================================================
// 🔐 身分驗證邏輯 (Google 登入驗證)
// ==========================================================================

async function checkUserSession() {
  const { data: { session } } = await supabaseClient.auth.getSession();
  
  if (session) {
    state.user = session.user;
    if (!state.user.user_metadata.custom_name) {
      await supabaseClient.auth.updateUser({
        data: {
          custom_name: state.user.user_metadata.full_name || "我",
          avatar_txt: (state.user.user_metadata.full_name || "我").slice(0, 1),
          birthday: "",
          gender: "boy",
          cloth_color: "lavender",
          partner_alias: "",
          partner_birthday: ""
        }
      });
      const { data: { user: updatedUser } } = await supabaseClient.auth.getUser();
      state.user = updatedUser;
    }
    await loadDiaryAndLetters();
  } else {
    state.user = null;
    render();
  }
}

async function loginWithGoogle() {
  const { error } = await supabaseClient.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: "https://tigua111.github.io/ourpage1.0/index.html" 
    }
  });
  if (error) showToast("Google 登入失敗: " + error.message);
}

async function logout() {
  await supabaseClient.auth.signOut();
  clearTimers();
  state.user = null;
  state.activeDiary = null;
  state.letters = [];
  state.partner = null;
  state.hasShowedTutorial = false;
  render();
}

// ==========================================================================
// 💾 雲端資料庫讀寫與即時監聽 (Supabase Realtime)
// ==========================================================================

async function loadDiaryAndLetters() {
  if (!state.user) return;

  const { data: diaries, error } = await supabaseClient
    .from('diaries')
    .select('*')
    .or(`user1_id.eq.${state.user.id},user2_id.eq.${state.user.id}`)
    .maybeSingle();

  if (error) {
    console.error("雲端日記讀取失敗:", error);
    return;
  }

  if (diaries) {
    state.activeDiary = diaries;
    
    const partnerId = diaries.user1_id === state.user.id ? diaries.user2_id : diaries.user1_id;
    if (partnerId) {
      state.partner = {
        id: partnerId,
        name: diaries.user1_id === state.user.id ? "親愛的另一半" : "房間創建者"
      };
    } else {
      state.partner = null;
    }

    const { data: letters } = await supabaseClient
      .from('letters')
      .select('*')
      .eq('diary_id', diaries.id)
      .order('created_at', { ascending: true });
    
    state.letters = letters || [];
    subscribeToNewLetters(diaries.id);
  }

  render();
}

function subscribeToNewLetters(diaryId) {
  supabaseClient
    .channel('realtime-letters')
    .on('postgres_changes', { 
        event: '*', 
        schema: 'public', 
        table: 'letters', 
        filter: `diary_id=eq.${diaryId}` 
    }, async (payload) => {
      await loadDiaryAndLetters();
    })
    .subscribe();

  supabaseClient
    .channel('realtime-diaries')
    .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'diaries',
        filter: `id=eq.${diaryId}`
    }, async (payload) => {
      await loadDiaryAndLetters();
    })
    .subscribe();
}

// ==========================================================================
// 🎨 網頁動態 UI 渲染與互動
// ==========================================================================

function render() {
  if (!state.user) {
    renderAuth();
    return;
  }
  if (!state.activeDiary) {
    renderChoice();
    return;
  }
  renderRoom();
}

function renderAuth() {
  app.innerHTML = `
    <main class="auth-screen">
      <section class="auth-panel" style="text-align: center; padding: 40px 28px;">
        <div class="brand-lockup" style="justify-content: center; margin-bottom: 32px;">
          <div class="brand-icon" aria-hidden="true"></div>
          <div style="text-align: left;">
            <h1>兩人的每日日記</h1>
            <p class="subtle">把每天留下來，慢慢放進同一本書裡。</p>
          </div>
        </div>
        <p style="margin-bottom: 24px; font-weight: bold; color: var(--muted);">歡迎回來！請先完成安全驗證</p>
        <button class="primary-button" id="googleLoginBtn" type="button">
          🔑 使用 Google 帳號登入
        </button>
      </section>
    </main>
  `;
  document.querySelector("#googleLoginBtn").addEventListener("click", loginWithGoogle);
}

function renderChoice() {
  app.innerHTML = `
    <main class="choice-screen">
      <section class="choice-panel">
        <div class="choice-header">
          <div>
            <h1>歡迎，今天想放進哪一本？</h1>
            <p class="subtle">創建一本新的雲端日記，或輸入對方的配對邀請碼。</p>
          </div>
          <button class="tiny-button" id="logoutBtn" type="button">登出</button>
        </div>
        <div class="choice-grid">
          <article class="choice-tile">
            <div>
              <div class="choice-art create" aria-hidden="true"></div>
              <h2>創建新日記</h2>
            </div>
            <form id="createForm">
              <div class="field">
                <label for="diaryName">日記本名稱</label>
                <input id="diaryName" name="diaryName" maxlength="18" value="我們的小日記" required />
              </div>
              <button class="primary-button" type="submit">建立日記</button>
            </form>
          </article>
          <article class="choice-tile">
            <div>
              <div class="choice-art join" aria-hidden="true"></div>
              <h2>加入對方的日記</h2>
            </div>
            <form id="joinForm">
              <div class="field">
                <label for="inviteCode">配對邀請碼</label>
                <input id="inviteCode" name="inviteCode" maxlength="6" placeholder="請輸入6位邀請碼" inputmode="latin" autocomplete="off" required />
              </div>
              <button class="primary-button" type="submit">確認加入</button>
              <p class="error-text" id="joinError"></p>
            </form>
          </article>
        </div>
      </section>
    </main>
  `;

  document.querySelector("#logoutBtn").addEventListener("click", logout);
  
  document.querySelector("#createForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = new FormData(event.currentTarget).get("diaryName").trim() || "我們的小日記";
    const code = Math.random().toString(36).slice(2, 8).toUpperCase(); 
    
    const { error } = await supabaseClient
      .from('diaries')
      .insert([{ code, name, user1_id: state.user.id }]);

    if (!error) {
      await loadDiaryAndLetters();
    } else {
      showToast("建立失敗，請重試");
    }
  });

  document.querySelector("#joinForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const code = new FormData(event.currentTarget).get("inviteCode").trim().toUpperCase();
    const errorEl = document.querySelector("#joinError");

    const { data: diary } = await supabaseClient
      .from('diaries')
      .select('*')
      .eq('code', code)
      .maybeSingle();

    if (!diary) {
      errorEl.textContent = "找不到此邀請碼，請跟對方確認";
      return;
    }
    if (diary.user1_id === state.user.id) {
      errorEl.textContent = "你不能自己加入自己創建的日記本";
      return;
    }
    if (diary.user2_id) {
      errorEl.textContent = "這本日記本的兩名額已滿";
      return;
    }

    const { error } = await supabaseClient
      .from('diaries')
      .update({ user2_id: state.user.id })
      .eq('id', diary.id);

    if (!error) {
      await loadDiaryAndLetters();
    } else {
      errorEl.textContent = "配對失敗，請稍後再試";
    }
  });
}

function renderRoom() {
  const meta = state.user.user_metadata;
  const myName = meta.custom_name || meta.full_name || "我";
  const myAvatarTxt = meta.avatar_txt || myName.slice(0, 1);
  const myCloth = meta.cloth_color || "lavender";
  const myGender = meta.gender || "boy";
  const partnerAlias = meta.partner_alias || (state.partner ? state.partner.name : "另一半");

  const processedLetters = state.letters.map(l => ({
    ...l,
    direction: l.sender_id === state.user.id ? "outgoing" : "incoming",
    date: l.date_key, 
    text: l.text
  }));

  const unread = processedLetters.filter((l) => l.direction === "incoming" && l.status === "unread");
  const inbox = processedLetters.filter((l) => l.direction === "incoming" && l.status !== "archived");
  const archived = processedLetters.filter((l) => l.direction === "incoming" && l.status === "archived");
  const sentToday = processedLetters.some((l) => l.direction === "outgoing" && l.date_key === todayKey);
  const latestIncoming = processedLetters.filter(l => l.direction === "incoming").sort((a, b) => b.created_at.localeCompare(a.created_at))[0];

  app.innerHTML = `
    <main class="app-shell">
      <header class="room-header">
        <div class="room-title">
          <div class="avatar" aria-hidden="true" id="myRoomAvatarBtn" style="cursor: pointer; background: var(--teal);">${escapeHtml(myAvatarTxt)}</div>
          <div>
            <h1>${escapeHtml(state.activeDiary.name)}</h1>
            <p class="subtle">${escapeHtml(myName)} · 雲端即時連線中</p>
          </div>
        </div>
        <div class="header-actions">
          <span class="date-pill">${formatDate(todayKey)}</span>
          <button class="code-pill" id="copyCodeBtn" type="button" title="複製邀請碼">邀請碼 ${escapeHtml(state.activeDiary.code)}</button>
          <button class="icon-button" id="openSettingsBtn" type="button" title="個人設定">⚙️</button>
          <button class="icon-button" id="logoutBtn" type="button" title="登出系統">↩</button>
        </div>
      </header>
      <section class="room-wrap">
        <div class="room-scene image-room" id="roomScene" aria-label="像素小書房">
          
          <div class="door-mask" aria-hidden="true"></div>
          <button class="hotspot desk-hotspot" id="deskHotspot" type="button" aria-label="書桌" ${state.partner ? "" : "disabled"}></button>
          <button class="hotspot shelf-hotspot" id="shelfHotspot" type="button" aria-label="書櫃"></button>
          <div class="bed-blanket" aria-hidden="true"></div>

          <div class="character ${myGender} c-${myCloth}" id="character" style="--x: ${spots.center.x}px; --y: ${spots.center.y}px; z-index: 4;">
            <div class="hair"></div><div class="head"></div><div class="eye left"></div><div class="eye right"></div>
            <div class="body"></div><div class="leg left"></div><div class="leg right"></div>
            <div class="letter"></div><div class="zzz">Zz</div>
          </div>
          
          <div id="tutorialContainer"></div>
        </div>
        <aside class="status-panel">
          <div class="status-block">
            <h2>今天</h2>
            <div class="counter-row">
              <div class="counter"><span><strong>${sentToday ? "1" : "0"}</strong>已寄</span></div>
              <div class="counter"><span><strong>${unread.length}</strong>新信</span></div>
              <div class="counter"><span><strong>${archived.length}</strong>收納</span></div>
            </div>
          </div>
          <div class="status-block">
            <h2>來自對方的最新話語</h2>
            ${latestIncoming ? miniCard(latestIncoming) : '<p class="subtle">還沒有對方的卡片</p>'}
          </div>
          
          <button class="secondary-button" id="openComputerBtn" type="button" ${state.partner ? "" : "disabled"}>🖥️ 打開電腦</button>
          <button class="secondary-button" id="openInboxBtn" type="button" ${inbox.length ? "" : "disabled"}>打開新信</button>
          
          <div class="status-block partner-card-block">
            <h2>💕 另一半的小屋情報</h2>
            ${state.partner ? `
              <div class="partner-info-box">
                <div class="avatar" style="background: var(--coral); font-size: 1.1rem; width: 38px; height: 38px;">❤️</div>
                <div style="flex: 1; min-width: 0;">
                  <div style="font-weight: 900; display: flex; align-items: center; justify-content: space-between;">
                    <span class="partner-display-name">${escapeHtml(partnerAlias)}</span>
                    <button class="alias-edit-btn" id="editPartnerAliasBtn" type="button">✏️</button>
                  </div>
                  <p class="subtle" style="font-size: 0.82rem; margin-top: 2px;">生日：${formatDate(meta.partner_birthday)}</p>
                </div>
              </div>
            ` : `
              <p class="subtle" style="font-size: 0.85rem; text-align: center; padding: 6px 0;">等待另一半輸入邀請碼加入房間...</p>
            `}
          </div>
        </aside>
      </section>
    </main>
    <div id="modalRoot"></div>
    <div id="toastRoot"></div>
  `;

  bindRoomEvents(processedLetters);
  startAmbientLife();

  if (state.letters.length === 0 && !state.hasShowedTutorial) {
    state.hasShowedTutorial = true;
    window.setTimeout(runTutorial, 600);
  } else {
    const unreadLetter = unread[0];
    reminderTimer = window.setTimeout(() => {
      if (unreadLetter) {
        showEnvelope(unreadLetter.id, processedLetters);
      } else if (!sentToday && state.dismissedReminder !== todayKey) {
        showReminder();
      }
    }, 500);
  }
}

function bindRoomEvents(processedLetters) {
  const desk = document.querySelector("#deskHotspot");
  const shelf = document.querySelector("#shelfHotspot");
  const openComputerBtn = document.querySelector("#openComputerBtn");
  const inboxBtn = document.querySelector("#openInboxBtn");
  const copyCodeBtn = document.querySelector("#copyCodeBtn");
  const openSettingsBtn = document.querySelector("#openSettingsBtn");
  const myRoomAvatarBtn = document.querySelector("#myRoomAvatarBtn");
  const editPartnerAliasBtn = document.querySelector("#editPartnerAliasBtn");
  const logoutBtn = document.querySelector("#logoutBtn");

  if (desk) desk.addEventListener("click", openComputerWorkspace);
  if (openComputerBtn) openComputerBtn.addEventListener("click", openComputerWorkspace);
  
  if (openSettingsBtn) openSettingsBtn.addEventListener("click", openSettingsPanel);
  if (myRoomAvatarBtn) myRoomAvatarBtn.addEventListener("click", openSettingsPanel);
  
  if (editPartnerAliasBtn) {
    editPartnerAliasBtn.addEventListener("click", () => {
      const currentAlias = state.user.user_metadata.partner_alias || "";
      const currentBirthday = state.user.user_metadata.partner_birthday || "";
      const modal = document.querySelector("#modalRoot");
      modal.innerHTML = `
        <div class="overlay" role="dialog" aria-modal="true">
          <section class="composer-panel" style="width: min(380px, 100%); padding: 18px;">
            <h3 style="font-weight:900; margin-bottom: 12px;">✏️ 設定另一半資訊</h3>
            <div class="field" style="margin: 8px 0;">
              <label>專屬暱稱</label>
              <input id="newAliasInput" value="${escapeHtml(currentAlias)}" placeholder="幫另一半取個專屬暱稱吧" maxlength="12"/>
            </div>
            <div class="field" style="margin: 8px 0;">
              <label>對方的生日</label>
              <input id="partnerBdayInput" type="date" value="${currentBirthday}"/>
            </div>
            <div class="button-row" style="margin-top: 16px; justify-content: flex-end;">
              <button class="tiny-button" id="saveAliasCancel" type="button">取消</button>
              <button class="tiny-button" id="saveAliasConfirm" type="button" style="background: var(--sun);">儲存</button>
            </div>
          </section>
        </div>
      `;
      document.querySelector("#saveAliasCancel").addEventListener("click", () => { modal.innerHTML = ""; });
      document.querySelector("#saveAliasConfirm").addEventListener("click", async () => {
        const val = document.querySelector("#newAliasInput").value.trim();
        const bday = document.querySelector("#partnerBdayInput").value;
        showToast("同步中...");
        await supabaseClient.auth.updateUser({
          data: { partner_alias: val, partner_birthday: bday }
        });
        const { data: { user } } = await supabaseClient.auth.getUser();
        state.user = user;
        modal.innerHTML = "";
        renderRoom();
      });
    });
  }

  if (shelf) {
    shelf.addEventListener("click", () => {
      const currentProcessed = state.letters.map(l => ({
        ...l,
        direction: l.sender_id === state.user.id ? "outgoing" : "incoming",
        date: l.date_key,
        text: l.text
      }));
      showArchive(currentProcessed);
    });
  }
  
  if (inboxBtn) {
    inboxBtn.addEventListener("click", () => {
      const currentProcessed = state.letters.map(l => ({
        ...l,
        direction: l.sender_id === state.user.id ? "outgoing" : "incoming",
        date: l.date_key,
        text: l.text
      }));
      const letter = currentProcessed.find((item) => item.direction === "incoming" && item.status === "unread")
        || currentProcessed.find((item) => item.direction === "incoming" && item.status === "opened");
      if (letter) showEnvelope(letter.id, currentProcessed);
    });
  }
  
  if (copyCodeBtn) {
    copyCodeBtn.addEventListener("click", () => {
      if (state.activeDiary && state.activeDiary.code) {
        copyInviteCode(state.activeDiary.code);
      }
    });
  }
  
  if (logoutBtn) {
    logoutBtn.addEventListener("click", logout);
  }

  document.querySelector("#roomScene").addEventListener("click", (e) => {
    if (e.target.classList.contains("hotspot") || e.target.closest(".overlay") || e.target.closest(".tutorial-overlay")) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;
    
    if (clickY >= 480 && clickY <= 720) {
      stopAmbientLife();
      executeMove({ x: clickX, y: clickY, action: "", z: 4 }, () => {
        roomTimer = window.setTimeout(startAmbientLife, 4000); 
      });
    }
  });
}

// ==========================================================================
// ⚙️ 個人設定面板
// ==========================================================================

function openSettingsPanel() {
  stopAmbientLife();
  const meta = state.user.user_metadata;
  const modal = document.querySelector("#modalRoot");
  
  modal.innerHTML = `
    <div class="overlay" role="dialog" aria-modal="true">
      <section class="choice-panel computer-modal-panel" style="width: min(500px, 100%); max-height: calc(100vh - 40px); overflow-y: auto;">
        <div class="panel-header">
          <div>
            <h2 style="font-size: 1.3rem;">⚙️ 小屋住戶個人設定</h2>
            <p class="subtle">調整你自己的頭像文字、名稱與小人外觀</p>
          </div>
          <button class="icon-button" id="closeSettingsBtn" type="button">×</button>
        </div>
        
        <form id="settingsForm" style="display: flex; flex-direction: column; gap: 14px;">
          <div class="field" style="margin:0;">
            <label>個人名稱</label>
            <input name="setCustomName" value="${escapeHtml(meta.custom_name || "")}" required placeholder="請輸入名字" maxlength="14"/>
          </div>
          
          <div class="field" style="margin:0;">
            <label>圓圈文字縮寫頭像 (限長度1字)</label>
            <input name="setAvatarTxt" value="${escapeHtml(meta.avatar_txt || (meta.custom_name || "我").slice(0, 1))}" required placeholder="如：M" maxlength="1" style="text-align: center; width: 64px; font-weight: 900;"/>
          </div>

          <div class="field" style="margin:0;">
            <label>個人生日</label>
            <input name="setBirthday" type="date" value="${meta.birthday || ""}"/>
          </div>

          <div class="field" style="margin:0;">
            <label>角色性別樣式</label>
            <div style="display: flex; gap: 14px; margin-top: 4px;">
              <label style="font-weight: normal; display: flex; align-items: center; gap: 6px; cursor:pointer;">
                <input type="radio" name="setGender" value="boy" ${meta.gender === "boy" ? "checked" : ""}/> 👦 像素小男生
              </label>
              <label style="font-weight: normal; display: flex; align-items: center; gap: 6px; cursor:pointer;">
                <input type="radio" name="setGender" value="girl" ${meta.gender === "girl" ? "checked" : ""}/> 👧 像素小女生
              </label>
            </div>
          </div>

          <div class="field" style="margin:0;">
            <label>像素衣服調色盤</label>
            <div class="cloth-palette-grid" style="display: flex; gap: 10px; margin-top: 6px;">
              <button type="button" class="palette-choice c-lavender ${meta.cloth_color === "lavender" ? "active" : ""}" data-color="lavender"></button>
              <button type="button" class="palette-choice c-coral ${meta.cloth_color === "coral" ? "active" : ""}" data-color="coral"></button>
              <button type="button" class="palette-choice c-teal ${meta.cloth_color === "teal" ? "active" : ""}" data-color="teal"></button>
              <button type="button" class="palette-choice c-sun ${meta.cloth_color === "sun" ? "active" : ""}" data-color="sun"></button>
              <button type="button" class="palette-choice c-leaf ${meta.cloth_color === "leaf" ? "active" : ""}" data-color="leaf"></button>
            </div>
            <input type="hidden" name="setClothColor" id="setClothColorHidden" value="${meta.cloth_color || "lavender"}"/>
          </div>

          <button class="primary-button" type="submit" style="margin-top: 10px;">💾 儲存並套用修改</button>
        </form>
      </section>
    </div>
  `;

  document.querySelector("#closeSettingsBtn").addEventListener("click", closeModalAndResume);
  
  const palettes = document.querySelectorAll(".palette-choice");
  palettes.forEach(btn => {
    btn.addEventListener("click", () => {
      palettes.forEach(p => p.classList.remove("active"));
      btn.classList.add("active");
      document.querySelector("#setClothColorHidden").value = btn.dataset.color;
    });
  });

  document.querySelector("#settingsForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    showToast("正在更新小屋基本資料...");

    try {
      const { error } = await supabaseClient.auth.updateUser({
        data: {
          custom_name: fd.get("setCustomName").trim(),
          avatar_txt: fd.get("setAvatarTxt").trim().slice(0, 1), 
          birthday: fd.get("setBirthday"),
          gender: fd.get("setGender"),
          cloth_color: fd.get("setClothColor")
        }
      });

      if (error) throw error;

      const { data: { user } } = await supabaseClient.auth.getUser();
      state.user = user;
      modal.innerHTML = "";
      renderRoom();
      showToast("個人資料修改成功！");
    } catch (err) {
      console.error("儲存設定失敗:", err);
      showToast("連線異常，儲存失敗");
    }
  });
}

// ==========================================================================
// 🎓 新手導覽、工作站面板其餘邏輯
// ==========================================================================

function runTutorial() {
  stopAmbientLife();
  executeMove(spots.center, () => { setCharacterAction(""); });

  const container = document.querySelector("#tutorialContainer");
  if (!container) return;

  let currentStep = 1;

  function renderStep() {
    if (currentStep > 3) {
      container.innerHTML = "";
      startAmbientLife();
      showToast("開始享受你們的小空間吧！");
      return;
    }

    let highlightClass = "";
    let guideTitle = "";
    let guideText = "";
    let tooltipClass = "";

    if (currentStep === 1) {
      highlightClass = "highlight-desk";
      guideTitle = "第一步：撰寫與紀錄";
      guideText = "點擊房間裡的「書桌電腦」或右側的「打開電腦」按鈕。左邊能編寫新卡片發給對方，右邊則能翻閱你過去寫給對方的歷史紀錄！";
      tooltipClass = "tip-desk";
    } else if (currentStep === 2) {
      highlightClass = "highlight-inbox";
      guideTitle = "第二步：開啟新信件";
      guideText = "當收到對方的每日小卡時，下方的「打開新信」按鈕會解鎖。點擊它可以拆開信封，查閱對方留在這間房間裡的即時悄悄話。";
      tooltipClass = "tip-inbox";
    } else if (currentStep === 3) {
      highlightClass = "highlight-shelf";
      guideTitle = "第三步：書櫃珍藏";
      guideText = "打開新信並按下「收納」後，卡片會被放進「中央書櫃」。點擊書櫃可以檢視所有你悉心留存、來自對方的歷史信件清單。";
      tooltipClass = "tip-shelf";
    }

    container.innerHTML = `
      <div class="tutorial-overlay ${highlightClass}">
        <div class="tutorial-tooltip ${tooltipClass}">
          <h3>${guideTitle}</h3>
          <p>${guideText}</p>
          <div style="text-align: right; margin-top: 10px;">
            <button class="tiny-button" id="nextTutorialBtn" type="button" style="background: var(--sun); font-weight: 900; min-height: 36px;">
              ${currentStep === 3 ? "完成教學 ➔" : "下一步 ➔"}
            </button>
          </div>
        </div>
      </div>
    `;

    document.querySelector("#nextTutorialBtn").addEventListener("click", (e) => {
      e.stopPropagation();
      currentStep++;
      renderStep();
    });
  }

  renderStep();
}

function openComputerWorkspace() {
  stopAmbientLife();
  state.dismissedReminder = todayKey;
  executeMove(spots.desk, () => {
    showComputerDashboard();
  });
}

function showComputerDashboard() {
  const modal = document.querySelector("#modalRoot");
  
  const mySentHistory = state.letters
    .filter(l => l.sender_id === state.user.id)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));

  // 🎯 這裡修正：呼叫 formatPrecisionTime 帶入精準發信時間
  const historyHtml = mySentHistory.map(l => `
    <div class="archive-item" style="margin-bottom: 8px; background: #fffdf6; border: 2px solid var(--line);">
      <div style="padding: 4px;">
        <div class="archive-date" style="font-size: 0.9rem;">${formatPrecisionTime(l.created_at, l.date_key)}</div>
        <p style="margin-top: 4px; font-size: 0.95rem; line-height: 1.4; word-break: break-all;">${escapeHtml(l.text)}</p>
      </div>
    </div>
  `).join("");

  modal.innerHTML = `
    <div class="overlay" role="dialog" aria-modal="true" aria-labelledby="compSystemTitle">
      <section class="choice-panel computer-modal-panel">
        <div class="panel-header" style="flex: 0 0 auto; margin-bottom: 14px;">
          <div>
            <h2 id="compSystemTitle">工作站主機 · 系統連線中</h2>
            <p class="subtle">今日日期：${formatDate(todayKey)}</p>
          </div>
          <button class="icon-button" id="closeComputerWorkspace" type="button" title="關閉系統">×</button>
        </div>
        
        <div class="choice-grid computer-modal-grid">
          <article class="choice-tile" style="min-height: auto; justify-content: flex-start; padding: 16px;">
            <h2 style="font-size: 1.15rem; margin-bottom: 4px;">✍️ 撰寫新卡片</h2>
            <p class="subtle" style="margin-bottom: 12px; margin-top: 0;">將今天的回憶或話語打包發送給對方。</p>
            <form id="composeForm" style="width: 100%; display: flex; flex-direction: column; flex: 1;">
              <div class="field" style="margin: 0 0 12px 0; flex: 1; display: flex; flex-direction: column;">
                <textarea id="letterText" name="letterText" maxlength="360" placeholder="寫點想對他/她說的話吧..." required style="flex: 1; min-height: 160px;"></textarea>
              </div>
              <button class="primary-button" type="submit" style="min-height: 44px; flex: 0 0 auto;">製成小卡</button>
              <p class="error-text" id="composeError" style="margin-top: 6px; min-height: auto;"></p>
            </form>
          </article>
          
          <article class="choice-tile" style="min-height: auto; justify-content: flex-start; padding: 16px; display: flex; flex-direction: column;">
            <h2 style="font-size: 1.15rem; margin-bottom: 4px;">📜 發送歷史紀錄</h2>
            <p class="subtle" style="margin-bottom: 12px; margin-top: 0;">你過去寄給對方的卡片清單（共 ${mySentHistory.length} 封）。</p>
            <div class="archive-list" style="width: 100%; flex: 1; overflow-y: auto; max-height: 260px; padding-right: 4px;">
              ${historyHtml || '<p class="subtle" style="text-align: center; margin-top: 40px;">你還沒有寄過任何卡片給對方喔。</p>'}
            </div>
          </article>
        </div>
      </section>
    </div>
  `;

  document.querySelector("#closeComputerWorkspace").addEventListener("click", closeModalAndResume);
  document.querySelector("#composeForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const text = new FormData(event.currentTarget).get("letterText").trim();
    if (!text) {
      document.querySelector("#composeError").textContent = "請寫下一內容";
      return;
    }
    boxCardPreview(text);
  });
}

function boxCardPreview(text) {
  const modal = document.querySelector("#modalRoot");
  modal.innerHTML = `
    <div class="overlay" role="dialog" aria-modal="true" aria-labelledby="previewTitle">
      <section class="composer-panel">
        <div class="panel-header">
          <div>
            <h2 id="previewTitle">確認卡片內容</h2>
            <p class="subtle">${formatDate(todayKey)}</p>
          </div>
          <button class="icon-button" id="closePreview" type="button" title="關閉">×</button>
        </div>
        <div class="card-preview">
          <div class="stamp" aria-hidden="true"></div>
          <p>${escapeHtml(text)}</p>
        </div>
        <div class="button-row" style="margin-top: 18px;">
          <button class="primary-button" id="sendCardBtn" type="button">確認寄送</button>
          <button class="secondary-button" id="editCardBtn" type="button">返回重寫</button>
        </div>
      </section>
    </div>
  `;

  document.querySelector("#closePreview").addEventListener("click", openComputerWorkspace);
  document.querySelector("#editCardBtn").addEventListener("click", showComputerDashboard);
  document.querySelector("#sendCardBtn").addEventListener("click", () => sendLetter(text));
}

function sendLetter(text) {
  if (!state.activeDiary) return;
  document.querySelector("#modalRoot").innerHTML = "";
  
  executeMove(spots.door, async () => {
    setCharacterAction("carrying");
    showToast("正在寄送...");

    const { error } = await supabaseClient
      .from('letters')
      .insert([{
        diary_id: state.activeDiary.id,
        sender_id: state.user.id,
        text: text,
        date_key: todayKey,
        status: 'unread'
      }]);

    if (!error) {
      showToast("已寄出");
      await loadDiaryAndLetters(); 
    } else {
      showToast("連線超時，寄送失敗");
    }

    roomTimer = window.setTimeout(() => {
      executeMove(spots.center, () => { setCharacterAction(""); });
    }, 1500);
  }, "carrying walking");
}

function showEnvelope(letterId, processedLetters) {
  const letter = processedLetters.find((item) => item.id === letterId);
  if (!letter) return;
  stopAmbientLife();
  
  const envelopeContent = letter.status === "opened"
    ? `
        <button class="tiny-button archive-top" id="archiveLetterBtn" type="button">收納</button>
        <article class="letter-card">
          <p>${escapeHtml(letter.text)}</p>
        </article>
      `
    : '<button class="primary-button open-button" id="openEnvelopeBtn" type="button">開啟</button>';
  
  const openedClass = letter.status === "opened" ? " opened" : "";
  const modal = document.querySelector("#modalRoot");
  modal.innerHTML = `
    <div class="overlay" role="dialog" aria-modal="true" aria-labelledby="envelopeTitle">
      <section class="modal-panel">
        <div class="panel-header">
          <div>
            <h2 id="envelopeTitle">新信</h2>
            <p class="subtle">${formatPrecisionTime(letter.created_at, letter.date)}</p>
          </div>
          <button class="icon-button" id="closeEnvelope" type="button" title="關閉">×</button>
        </div>
        <div class="envelope-stage">
          <div class="pixel-envelope${openedClass}" id="pixelEnvelope">${envelopeContent}</div>
        </div>
      </section>
    </div>
  `;

  document.querySelector("#closeEnvelope").addEventListener("click", closeModalAndResume);
  document.querySelector("#openEnvelopeBtn")?.addEventListener("click", () => openEnvelope(letter.id, processedLetters));
  document.querySelector("#archiveLetterBtn")?.addEventListener("click", () => archiveLetter(letter.id));
}

async function openEnvelope(letterId, processedLetters) {
  const letter = processedLetters.find((item) => item.id === letterId);
  if (!letter) return;
  
  await supabaseClient.from('letters').update({ status: "opened" }).eq('id', letterId);
  letter.status = "opened";

  const envelope = document.querySelector("#pixelEnvelope");
  envelope.classList.add("opened");
  envelope.innerHTML = `
    <button class="tiny-button archive-top" id="archiveLetterBtn" type="button">收納</button>
    <article class="letter-card">
      <p>${escapeHtml(letter.text)}</p>
    </article>
  `;
  document.querySelector("#archiveLetterBtn").addEventListener("click", () => archiveLetter(letter.id));
}

function archiveLetter(letterId) {
  document.querySelector("#modalRoot").innerHTML = "";
  
  executeMove(spots.bookshelf, async () => {
    showToast("收納中...");
    await supabaseClient.from('letters').update({ status: "archived" }).eq('id', letterId);
    await loadDiaryAndLetters();
    showToast("已收進書櫃");
    
    roomTimer = window.setTimeout(() => {
      executeMove(spots.center, () => { setCharacterAction(""); });
    }, 1200);
  }, "carrying walking");
}

function showArchive(processedLetters) {
  stopAmbientLife();
  
  executeMove(spots.bookshelf, () => {
    const archived = processedLetters
      .filter((letter) => letter.status === "archived" && letter.direction === "incoming")
      .sort((a, b) => b.date.localeCompare(a.date) || b.created_at.localeCompare(a.created_at));
      
    const grouped = archived.reduce((acc, letter) => {
      acc[letter.date] ||= [];
      acc[letter.date].push(letter);
      return acc;
    }, {});
    
    const list = Object.entries(grouped)
      .map(([date, letters]) => `
        <div class="archive-item">
          <div>
            <div class="archive-date">${formatDate(date)}</div>
            <small>${letters.length} 封</small>
          </div>
          <button class="tiny-button view-archive" data-date="${date}" type="button">查看</button>
        </div>
      `).join("");

    document.querySelector("#modalRoot").innerHTML = `
      <div class="overlay" role="dialog" aria-modal="true" aria-labelledby="archiveTitle">
        <section class="archive-panel">
          <div class="panel-header">
            <div>
              <h2 id="archiveTitle">書櫃櫃體</h2>
              <p class="subtle">珍藏了 ${archived.length} 封對方的卡片</p>
            </div>
            <button class="icon-button" id="closeArchive" type="button" title="關閉">×</button>
          </div>
          <div class="archive-list">
            ${list || '<p class="subtle">尚無收納信件</p>'}
          </div>
        </section>
      </div>
    `;

    document.querySelector("#closeArchive").addEventListener("click", closeModalAndResume);
    document.querySelectorAll(".view-archive").forEach((button) => {
      button.addEventListener("click", () => showArchiveDate(button.dataset.date, processedLetters));
    });
  });
}

function showArchiveDate(date, processedLetters) {
  const letters = processedLetters.filter((letter) => letter.status === "archived" && letter.date === date && letter.direction === "incoming");
  const cards = letters.map((letter) => miniCard(letter)).join("");
  
  document.querySelector("#modalRoot").innerHTML = `
    <div class="overlay" role="dialog" aria-modal="true" aria-labelledby="archiveDateTitle">
      <section class="archive-panel">
        <div class="panel-header">
          <div>
            <h2 id="archiveDateTitle">${formatDate(date)}</h2>
            <p class="subtle">${letters.length} 封卡片</p>
          </div>
          <button class="icon-button" id="closeArchiveDate" type="button" title="關閉">×</button>
        </div>
        <div class="archive-list">${cards}</div>
        <div class="button-row" style="margin-top: 18px;">
          <button class="secondary-button" id="backArchive" type="button">返回書櫃</button>
        </div>
      </section>
    </div>
  `;
  document.querySelector("#closeArchiveDate").addEventListener("click", closeModalAndResume);
  document.querySelector("#backArchive").addEventListener("click", () => showArchive(processedLetters));
}

function showReminder() {
  pendingReminder = true;
  stopAmbientLife();
  document.querySelector("#modalRoot").innerHTML = `
    <div class="overlay" role="dialog" aria-modal="true" aria-labelledby="reminderTitle">
      <section class="modal-panel">
        <div class="panel-header">
          <div>
            <h2 id="reminderTitle">今天的信</h2>
            <p class="subtle">${formatDate(todayKey)}</p>
          </div>
          <button class="icon-button" id="dismissReminder" type="button" title="稍後">×</button>
        </div>
        <div class="card-preview">
          <div class="stamp" aria-hidden="true"></div>
          <p>今天也留一點話給對方吧。</p>
        </div>
        <div class="button-row" style="margin-top: 18px;">
          <button class="primary-button" id="reminderWrite" type="button">打開電腦寫信</button>
          <button class="secondary-button" id="reminderLater" type="button">稍後</button>
        </div>
      </section>
    </div>
  `;
  document.querySelector("#dismissReminder").addEventListener("click", dismissReminder);
  document.querySelector("#reminderLater").addEventListener("click", dismissReminder);
  document.querySelector("#reminderWrite").addEventListener("click", () => {
    pendingReminder = false;
    document.querySelector("#modalRoot").innerHTML = "";
    openComputerWorkspace();
  });
}

function dismissReminder() {
  pendingReminder = false;
  state.dismissedReminder = todayKey;
  closeModalAndResume();
}

function closeModalAndResume() {
  document.querySelector("#modalRoot").innerHTML = "";
  if (!pendingReminder) {
    setCharacterAction("");
    startAmbientLife();
  }
}

// ==========================================================================
// 🚶‍♂️ 角色像素動畫與地圖移動控制邏輯
// ==========================================================================

function executeMove(targetSpot, callback, customWalkClass = "walking") {
  const character = document.querySelector("#character");
  if (!character) {
    if (callback) callback();
    return;
  }

  const currentX = parseInt(character.style.getPropertyValue("--x")) || spots.center.x;
  const currentY = parseInt(character.style.getPropertyValue("--y")) || spots.center.y;

  if (currentX === targetSpot.x && currentY === targetSpot.y) {
    character.style.zIndex = targetSpot.z;
    if (targetSpot.action) setCharacterAction(targetSpot.action);
    if (callback) callback();
    return;
  }

  const isLeft = targetSpot.x < currentX;
  if (isLeft) {
    character.classList.add("flip");
  } else {
    character.classList.remove("flip");
  }

  character.className = `character ${customWalkClass}`.trim();
  if (isLeft) character.classList.add("flip");

  const duration = Math.max(300, Math.min(1800, Math.abs(targetSpot.x - currentX) * 3));
  
  character.style.transition = `calc(var(--pixel) * 0.03s) steps(4) infinite, left ${duration}ms linear, top ${duration}ms linear`;
  character.style.left = `${targetSpot.x}px`;
  character.style.top = `${targetSpot.y}px`;
  character.style.setProperty("--x", `${targetSpot.x}px`);
  character.style.setProperty("--y", `${targetSpot.y}px`);

  window.setTimeout(() => {
    character.style.transition = "";
    character.style.zIndex = targetSpot.z;
    setCharacterAction(targetSpot.action);
    if (callback) callback();
  }, duration);
}

function setCharacterAction(action) {
  const character = document.querySelector("#character");
  if (!character) return;
  
  const hasFlip = character.classList.contains("flip");
  character.className = `character ${action}`.trim();
  if (hasFlip) character.classList.add("flip");
}

function startAmbientLife() {
  if (characterTimer) window.clearTimeout(characterTimer);
  
  const ambientSpots = [spots.center, spots.desk, spots.center, spots.bookshelf, spots.center, spots.bed];
  let index = 0;

  function nextStep() {
    const target = ambientSpots[index % ambientSpots.length];
    index++;
    
    executeMove(target, () => {
      characterTimer = window.setTimeout(nextStep, 4000);
    });
  }
  characterTimer = window.setTimeout(nextStep, 1000);
}

function stopAmbientLife() {
  if (characterTimer) window.clearTimeout(characterTimer);
  if (roomTimer) window.clearTimeout(roomTimer);
  characterTimer = null;
}

async function copyInviteCode(code) {
  try {
    await navigator.clipboard.writeText(code);
    showToast("邀請碼已複製");
  } catch {
    showToast(`邀請碼 ${code}`);
  }
}

function showToast(message) {
  const root = document.querySelector("#toastRoot") || document.body;
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;
  root.appendChild(toast);
  window.setTimeout(() => toast.remove(), 1800);
}

// 🎯 這裡修正：呼叫 formatPrecisionTime 顯示精確時間戳記
function miniCard(letter) {
  const who = letter.direction === "incoming" ? "對方" : "我";
  return `
    <div class="mini-card">
      <p>${escapeHtml(letter.text)}</p>
      <div class="mini-card-meta">${who} · ${formatPrecisionTime(letter.created_at, letter.date)}</div>
    </div>
  `;
}

// 🚀 啟動連線初始化
checkUserSession();
