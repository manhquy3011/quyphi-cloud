/*
 * Quý Phi Cloud v8 — lớp đồng bộ dùng chung cho ứng dụng v7.
 * - localStorage v7 chỉ dùng để chuyển dữ liệu lần đầu, tuyệt đối không ghi đè.
 * - Supabase là nguồn dữ liệu chính; cache riêng theo tài khoản để phòng mất mạng.
 * - Mọi lần ghi lên Cloud đều kiểm tra revision, phát hiện thay đổi đồng thời.
 * - Không tự nhập dữ liệu cũ nếu chưa có sự đồng ý của chủ trọ.
 */
'use strict';
const CLOUD_LEGACY_KEY = 'quan_ly_phong_tro_v1';
const CLOUD_CACHE_PREFIX = 'quyphi_cloud_cache_v1:';
let cloudClient = null;
let cloudUser = null;
let cloudRevision = 0;
let cloudReady = false;
let cloudDirty = false;
let cloudSending = false;
let cloudConflict = false;
let cloudSequence = 0;
let cloudTimer = null;
let cloudPollBusy = false;
let cloudStarted = false;
let cloudLastError = '';
let cloudLastUpdatedAt = null;

function cloudEl(name){return document.getElementById(name);}
function cloudCacheKey(){
  const project = new URL(window.QUYPHI_CLOUD.url).hostname;
  return `${CLOUD_CACHE_PREFIX}${project}:${cloudUser.id}`;
}
function cloudReadCache(){
  try {
    const text = localStorage.getItem(cloudCacheKey());
    if (!text) return null;
    const cached = JSON.parse(text);
    return {revision: Number(cached.revision), dirty: cached.dirty === true,
      data: validateData(cached.data)};
  } catch(error){
    console.warn('Bản tạm trên thiết bị không đọc được:',error);
    return null;
  }
}
function cloudPersistCache(){
  try {
    localStorage.setItem(cloudCacheKey(), JSON.stringify({
      revision:cloudRevision, dirty:cloudDirty, data:state, savedAt:new Date().toISOString()
    }));
    return true;
  } catch(error){
    console.error('Không lưu được bản sao tạm:',error);
    return false;
  }
}
// Thời điểm cập nhật thật do Supabase lưu trong cột updated_at (giờ Việt Nam).
function cloudLastUpdateLabel(){
  if(!cloudLastUpdatedAt) return '☁️ Đã đồng bộ dữ liệu mới nhất (chưa có thời gian cập nhật)';
  const date=new Date(cloudLastUpdatedAt);
  if(Number.isNaN(date.getTime()))return '☁️ Đã đồng bộ dữ liệu mới nhất';
  return '☁️ Đã cập nhật dữ liệu mới nhất lúc '+new Intl.DateTimeFormat('vi-VN',{
    timeZone:'Asia/Ho_Chi_Minh',day:'2-digit',month:'2-digit',year:'numeric',
    hour:'2-digit',minute:'2-digit',hour12:false
  }).format(date);
}
// Đọc dấu thời gian của đúng revision đã lưu, tránh nhầm với thiết bị khác.
async function cloudReadUpdatedAt(revision){
  try{
    const {data,error}=await cloudClient.from('quyphi_app_state')
      .select('updated_at').eq('owner_id',cloudUser.id)
      .eq('revision',revision).maybeSingle();
    if(error) throw error;
    return data?.updated_at||null;
  }catch(err){console.warn('Không lấy được giờ cập nhật:',err);return null;}
}
function cloudStatus(message, level='good'){
  const bar = cloudEl('cloudSyncStatus');
  bar.textContent = message;
  bar.dataset.level = level;
  cloudEl('cloudRefreshBtn').textContent = cloudDirty ? '↻ Gửi thay đổi' : '↻ Tải dữ liệu mới';
}
function cloudShowGate(message, mode='login'){
  cloudEl('cloudGate').hidden=false;
  document.body.classList.add('cloud-locked');
  cloudEl('cloudGateMessage').textContent=message;
  cloudEl('cloudLoginForm').hidden=mode!=='login';
  cloudEl('cloudSetupActions').hidden=mode!=='setup';
  cloudEl('cloudConflictActions').hidden=mode!=='conflict';
  cloudEl('cloudRetryBtn').hidden=mode!=='retry';
}
function cloudOpenApp(){
  cloudEl('cloudGate').hidden=true;
  document.body.classList.remove('cloud-locked');
  cloudEl('cloudAccount').textContent=cloudUser.email || 'Chủ trọ';
  cloudEl('cloudToolbar').hidden=false;
  render();
}
function cloudMakeDefaultData(){
  return {
    settings:copy(DEFAULT_SETTINGS), rooms:[], bills:[],
    flexRooms:[], flexEntries:[], meterAccounts:copy(DEFAULT_METERS),
    meterPayments:[], expenses:[], flexWaterPayments:[], depositTransactions:[], settlements:[]
  };
}
function cloudReadLegacy(){
  const text = localStorage.getItem(CLOUD_LEGACY_KEY);
  if (!text) return null;
  return validateData(JSON.parse(text));
}
async function cloudGetRemote(){
  const {data,error} = await cloudClient.from('quyphi_app_state')
    .select('revision,data,updated_at').eq('owner_id',cloudUser.id).maybeSingle();
  if (error) throw error;
  return data;
}
function cloudIsConflict(error){
  return (error?.message||'').includes('REVISION_CONFLICT');
}
function cloudBlockConflict(){
  cloudConflict=true;
  cloudStatus('⚠️ Xung đột: một thiết bị khác đã lưu dữ liệu mới. Chưa ghi đè.', 'error');
  cloudShowGate('Dữ liệu trên Cloud đã thay đổi ở thiết bị khác. Thay đổi trên máy này vẫn nằm trong bản sao tạm. Hãy xuất JSON dự phòng, sau đó tải lại Cloud. Không có thao tác gộp tự động.', 'conflict');
}
// Lệnh đồng bộ có revision: máy khác vừa lưu thì SQL từ chối ghi đè.
async function cloudFlush(){
  if (!cloudClient || !cloudUser || !cloudReady || cloudSending || !cloudDirty || cloudConflict) return;
  cloudSending=true;
  try {
    while (cloudDirty && !cloudConflict) {
      const snapshot = copy(state);
      const sequence = cloudSequence;
      cloudStatus('⏳ Đang đồng bộ lên Cloud...', 'pending');
      const {data,error} = await cloudClient.rpc('quyphi_save_state', {
        p_expected_revision:cloudRevision, p_data:snapshot
      });
      if (error) {
        if (cloudIsConflict(error)) { cloudBlockConflict(); break; }
        cloudLastError=error.message;
        cloudStatus('⚠️ Chưa đồng bộ: '+error.message+' — bản tạm vẫn còn trên máy', 'error');
        break;
      }
      cloudRevision=Number(data);
      cloudDirty=sequence!==cloudSequence;
      // Lấy thời gian DB thật sau khi RPC lưu thành công.
      cloudLastUpdatedAt=await cloudReadUpdatedAt(cloudRevision)||null;
      cloudLastError='';
      if (!cloudPersistCache()) {
        cloudStatus('⚠️ Cloud đã lưu, nhưng không cập nhật được bản tạm trên máy', 'error');
      } else if (!cloudDirty) {
        cloudStatus(cloudLastUpdateLabel(),'good');
      }
    }
  } catch(error) {
    cloudLastError=error.message;
    cloudStatus('⚠️ Mạng hoặc Cloud chưa sẵn sàng: '+error.message, 'error');
  } finally {
    cloudSending=false;
  }
}
// Được gọi từ các chức năng v7. Trả về đồng bộ để tương thích `if(!save())`.
// Đây là bước lưu bản tạm, việc Cloud xác nhận diễn ra sau đó.
function cloudSaveLocal(){
  if (!cloudReady || !cloudUser || cloudConflict) {
    alert('Chưa sẵn sàng lưu Cloud hoặc đang có xung đột dữ liệu.');
    return false;
  }
  const previousDirty=cloudDirty, previousSequence=cloudSequence;
  cloudDirty=true;
  cloudSequence++;
  if (!cloudPersistCache()) {
    cloudDirty=previousDirty;
    cloudSequence=previousSequence;
    alert('Bộ nhớ trình duyệt không đủ để lưu bản tạm. Hãy xuất JSON và kiểm tra dung lượng.');
    return false;
  }
  cloudStatus('⏳ Đã lưu tạm trên máy, đang chờ Cloud...', 'pending');
  clearTimeout(cloudTimer);
  cloudTimer=setTimeout(()=>{void cloudFlush();},250);
  return true;
}

async function cloudPull(){
  if (!cloudReady || !cloudUser || cloudPollBusy || cloudSending || cloudConflict) return;
  if (cloudDirty) {await cloudFlush(); return;}
  // Nếu đang mở form và gõ, không tự thay nội dung giữa chừng.
  if ([...document.querySelectorAll('dialog')].some(dialog=>dialog.open)) return;
  cloudPollBusy=true;
  try {
    const remote=await cloudGetRemote();
    if (cloudDirty || cloudSending || cloudConflict) return;
    if (!remote) { cloudBlockConflict(); return; }
    const newRevision=Number(remote.revision);
    if (newRevision!==cloudRevision) {
      const fresh=validateData(remote.data);
      state=fresh;
      cloudRevision=newRevision;
      cloudLastUpdatedAt=remote.updated_at||null;
      cloudPersistCache();
      render();
      cloudStatus(cloudLastUpdateLabel(),'good');
    } else {
      cloudLastUpdatedAt=remote.updated_at||cloudLastUpdatedAt;
      cloudStatus(cloudLastUpdateLabel(),'good');
    }
  } catch(error){
    cloudStatus('⚠️ Không đọc được Cloud: '+error.message,'error');
  } finally {cloudPollBusy=false;}
}
async function cloudLoadAccount(){
  cloudReady=false;
  cloudDirty=false;
  cloudConflict=false;
  cloudRevision=0;
  cloudSequence=0;
  cloudLastUpdatedAt=null;
  cloudShowGate('Đang kiểm tra dữ liệu trên Cloud...', 'loading');
  let remote;
  try { remote=await cloudGetRemote(); }
  catch(error){
    cloudLastError=error.message;
    cloudShowGate('Không tải được dữ liệu từ Supabase: '+error.message+'. Hãy kiểm tra SQL, kết nối mạng và thử lại.', 'retry');
    return;
  }
  const cache=cloudReadCache();
  if (remote) {
    try {
      const fresh=validateData(remote.data);
      const serverRevision=Number(remote.revision);
      cloudRevision=serverRevision;
      cloudLastUpdatedAt=remote.updated_at||null;
      if (cache?.dirty) {
        if (cache.revision!==serverRevision) {
          state=cache.data; cloudRevision=cache.revision; cloudDirty=true;
          cloudBlockConflict(); return;
        }
        // Lần trước đóng trình duyệt trước khi kịp đồng bộ.
        state=cache.data; cloudDirty=true; cloudSequence=1;
      } else { state=fresh; cloudDirty=false; }
      cloudReady=true;
      cloudPersistCache();
      cloudOpenApp();
      cloudStatus(cloudDirty?'⏳ Có thay đổi chưa gửi từ lần trước. Đang đồng bộ...':cloudLastUpdateLabel(),cloudDirty?'pending':'good');
      if (cloudDirty) void cloudFlush();
    } catch(error) {
      cloudShowGate('Dữ liệu trên Cloud không hợp lệ: '+error.message+'. Không thể tự động sửa hoặc ghi đè.', 'retry');
    }
    return;
  }
  // Không có row Cloud: nếu có cache chưa gửi từ phiên trước thì khôi phục, không mất dữ liệu.
  if (cache?.dirty && cache.revision>0) {
    state=cache.data; cloudRevision=cache.revision; cloudDirty=true; cloudSequence=1;
    cloudBlockConflict();
    return;
  }
  if (cache?.dirty && cache.revision===0) {
    state=cache.data;
    cloudReady=true;
    cloudDirty=true;
    cloudRevision=0;
    cloudSequence=1;
    cloudShowGate('Phát hiện bản dữ liệu chưa gửi lên Cloud trên máy này. Nhấn Thử lại để gửi, hoặc xuất bản sao JSON trước.', 'retry');
    return;
  }
  try {
    const old=cloudReadLegacy();
    cloudEl('cloudMigrateOld').hidden=!old;
    cloudShowGate(old
      ? `Cloud đang trống. Máy này có dữ liệu cũ: ${old.rooms.length} phòng thường, ${old.flexRooms.length} phòng thu riêng, ${old.bills.length} hóa đơn. Hãy đưa dữ liệu cũ lên Cloud (chỉ một lần).`
      : 'Cloud chưa có dữ liệu. Có thể nhập file sao lưu JSON v7 hoặc bắt đầu dữ liệu mới.', 'setup');
  } catch(error) {
    cloudEl('cloudMigrateOld').hidden=true;
    cloudShowGate('Cloud chưa có dữ liệu. Dữ liệu v7 trên máy đọc không được: '+error.message+'. Hãy dùng file sao lưu JSON để khôi phục, không xóa dữ liệu v7.', 'setup');
  }
}
// Xóa dữ liệu nghiệp vụ bằng việc GHI JSON rỗng trong cùng row (không xóa SQL, RLS, User).
// Yêu cầu đồng bộ sạch, hai lần xác nhận, và RPC CAS để tránh mất dữ liệu từ thiết bị khác.
async function cloudResetAllData(){
  if(!cloudReady||!cloudUser||cloudConflict){alert('Bạn cần đăng nhập và tải dữ liệu Cloud thành công trước.');return;}
  if(cloudDirty||cloudSending||cloudPollBusy){alert('Còn thao tác đang đồng bộ. Hãy chờ trạng thái Đã cập nhật, rồi thử lại.');return;}
  if(!cloudEl('resetBackupConfirmed').checked){
    alert('Trước tiên hãy xuất file sao lưu JSON, kiểm tra file đã tải về và đánh dấu ô xác nhận.');return;
  }
  const phrase=prompt('XÓA SẠCH TẤT CẢ DỮ LIỆU PHÒNG TRỌ, HÓA ĐƠN, THU CHI, CỌC, QR VÀ CÀI ĐẶT?\n\nĐể xác nhận, gõ đúng: XOA TOAN BO');
  if(phrase!=='XOA TOAN BO'){if(phrase!==null)alert('Cụm từ không đúng. Không có dữ liệu nào bị xóa.');return;}
  if(!confirm('Xác nhận lần cuối: thay toàn bộ dữ liệu Supabase của tài khoản này bằng dữ liệu trống? Bản sao lưu JSON đã lưu trên máy sẽ không bị xóa.'))return;

  cloudSending=true;
  cloudShowGate('Đang kiểm tra và khởi tạo dữ liệu mới. Vui lòng không đóng trang...', 'loading');
  try {
    const fresh=await cloudGetRemote();
    if(!fresh || Number(fresh.revision)!==cloudRevision){
      cloudSending=false;
      cloudBlockConflict();
      alert('Một thiết bị khác đã cập nhật dữ liệu. Thao tác xóa bị HỦY; hãy tải lại Cloud và xuất sao lưu mới.');
      return;
    }
    const empty=validateData(cloudMakeDefaultData());
    const {data,error}=await cloudClient.rpc('quyphi_save_state',{
      p_expected_revision:cloudRevision,p_data:empty
    });
    if(error){
      if(cloudIsConflict(error)){
        cloudSending=false;
        cloudBlockConflict();
        alert('Đã phát hiện thiết bị khác cập nhật dữ liệu. KHÔNG xóa dữ liệu Cloud.');
        return;
      }
      throw error;
    }
    // Chỉ thay state trên thiết bị SAU KHI Supabase xác nhận.
    state=empty;
    cloudRevision=Number(data);
    cloudDirty=false;
    cloudSequence++;
    cloudLastUpdatedAt=await cloudReadUpdatedAt(cloudRevision)||null;
    cloudEl('resetBackupConfirmed').checked=false;
    // Dữ liệu v7 cũ trên CHÍNH trình duyệt này cũng được dọn sau khi Cloud xác nhận.
    // Các bản sao lưu JSON và dữ liệu trình duyệt ở thiết bị khác không bị đụng tới.
    try{localStorage.removeItem(CLOUD_LEGACY_KEY);}catch(_){}
    selectedMonth=todayMonth();
    const cached=cloudPersistCache();
    cloudOpenApp();
    cloudStatus(cached?cloudLastUpdateLabel():'⚠️ Cloud đã xóa dữ liệu, nhưng không lưu được bản tạm trên máy',cached?'good':'error');
    alert('ĐÃ LÀM MỚI THÀNH CÔNG. Dữ liệu nghiệp vụ trên Cloud hiện trống. Giữ file JSON sao lưu để có thể phục hồi khi cần.');
  }catch(error){
    cloudOpenApp();
    cloudStatus('⚠️ Chưa thể làm mới dữ liệu: '+error.message,'error');
    alert('KHÔNG xác nhận xóa dữ liệu: '+error.message+'. Hãy kiểm tra lại trạng thái Supabase trước khi thao tác tiếp.');
  }finally{cloudSending=false;}
}

async function cloudBeginData(initial){
  const previousState=state;
  cloudReady=true;
  cloudRevision=0;
  cloudDirty=false;
  cloudSequence=0;
  state=validateData(initial);
  if (!cloudSaveLocal()) {
    state=previousState;
    cloudReady=false;
    return;
  }
  clearTimeout(cloudTimer);
  await cloudFlush();
  if (cloudConflict) return;
  if (cloudDirty) {
    cloudShowGate('Đã giữ bản dữ liệu tạm trên máy, nhưng Cloud chưa xác nhận. Bấm Thử lại khi có mạng.', 'retry');
  } else cloudOpenApp();
}
async function cloudLogin(event){
  event.preventDefault();
  const email=cloudEl('cloudEmail').value.trim();
  const password=cloudEl('cloudPassword').value;
  const button=cloudEl('cloudLoginBtn');
  button.disabled=true;
  cloudEl('cloudGateMessage').textContent='Đang đăng nhập...';
  try {
    const {data,error}=await cloudClient.auth.signInWithPassword({email,password});
    if (error) throw error;
    cloudUser=data.user;
    cloudEl('cloudPassword').value='';
    await cloudLoadAccount();
  } catch(error) {
    cloudShowGate('Đăng nhập thất bại: '+error.message, 'login');
  } finally {button.disabled=false;}
}
async function cloudLogout(){
  if (cloudDirty || cloudConflict) {
    alert('Còn dữ liệu chưa đồng bộ. Hãy xuất JSON, giải quyết xung đột hoặc kết nối lại trước khi đăng xuất.');
    return;
  }
  if(!confirm('Đăng xuất tài khoản Quý Phi trên thiết bị này?'))return;
  try {
    localStorage.removeItem(cloudCacheKey());
    const {error}=await cloudClient.auth.signOut();
    if(error)throw error;
    location.reload();
  } catch(error){alert('Không đăng xuất được: '+error.message);}
}
async function cloudRetry(){
  if (cloudReady && cloudDirty && !cloudConflict) {
    await cloudFlush();
    if (!cloudDirty && !cloudConflict) cloudOpenApp();
    else cloudShowGate('Chưa gửi được bản tạm lên Cloud. Kiểm tra kết nối, sau đó Thử lại.', 'retry');
  } else await cloudLoadAccount();
}
async function cloudDiscardConflict(){
  if (!confirm('Thao tác này LOẠI BỎ các thay đổi chưa đồng bộ trên thiết bị này và tải Cloud mới nhất. Bạn đã xuất bản sao JSON chưa?'))return;
  try{localStorage.removeItem(cloudCacheKey());}catch(_){}
  cloudConflict=false;cloudDirty=false;
  await cloudLoadAccount();
}
async function cloudRestoreFile(event){
  const file=event.target.files[0];event.target.value='';if(!file)return;
  if(file.size>10*1024*1024){alert('File sao lưu lớn hơn 10 MB.');return;}
  try {
    const parsed=JSON.parse(await file.text());
    if(parsed.app!=='QuanLyPhongTroOffline' || ![1,2,3,4,5,6].includes(parsed.version))
      throw Error('Chỉ chấp nhận file JSON sao lưu của ứng dụng Quý Phi v7.');
    const imported=validateData(parsed.data);
    if(!confirm(`Đưa lên Cloud: ${imported.rooms.length} phòng thường, ${imported.flexRooms.length} phòng thu riêng, ${imported.bills.length} hóa đơn?`))return;
    await cloudBeginData(imported);
  } catch(error) {alert('Không nhập được file JSON: '+error.message);}
}
function startCloudApp(){
  if (cloudStarted) return;
  cloudStarted=true;
  cloudShowGate('Đang kết nối Supabase...', 'loading');
  const config=window.QUYPHI_CLOUD;
  if (!config || !/^https:\/\/[^\s/]+\.supabase\.co\/?$/.test(config.url||'')
      || !config.publishableKey || config.publishableKey.includes('DAN_KEY')) {
    cloudShowGate('Chưa cấu hình Supabase. Mở file config.js trong VS Code rồi nhập Project URL và Publishable key.', 'config');
    return;
  }
  if (!window.supabase?.createClient) {
    cloudShowGate('Không tải được thư viện Supabase. Kiểm tra Internet hoặc chặn CDN trong trình duyệt.', 'config');
    return;
  }
  cloudClient=window.supabase.createClient(config.url, config.publishableKey, {
    auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}
  });
  cloudEl('cloudLoginForm').addEventListener('submit',event=>{void cloudLogin(event);});
  cloudEl('cloudMigrateOld').addEventListener('click',async()=>{
    try {const old=cloudReadLegacy();if(!old)throw Error('Không có dữ liệu cũ.');
      if(confirm('Chuyển toàn bộ dữ liệu v7 của máy này lên Supabase? Bản cũ trong trình duyệt không bị xóa.'))await cloudBeginData(old);
    } catch(error){alert(error.message);}
  });
  cloudEl('cloudStartEmpty').addEventListener('click',()=>{
    if(confirm('Bắt đầu Cloud với danh sách phòng trống? Chỉ làm khi không cần đưa dữ liệu v7 cũ lên.'))void cloudBeginData(cloudMakeDefaultData());
  });
  cloudEl('cloudSetupImport').addEventListener('click',()=>cloudEl('cloudSetupFile').click());
  cloudEl('cloudSetupFile').addEventListener('change',event=>{void cloudRestoreFile(event);});
  cloudEl('cloudRetryBtn').addEventListener('click',()=>{void cloudRetry();});
  cloudEl('cloudConflictExport').addEventListener('click',()=>exportBackup());
  cloudEl('cloudConflictReload').addEventListener('click',()=>{void cloudDiscardConflict();});
  cloudEl('cloudRefreshBtn').addEventListener('click',()=>{void cloudPull();});
  cloudEl('cloudLogoutBtn').addEventListener('click',()=>{void cloudLogout();});
  cloudClient.auth.getUser().then(({data,error})=>{
    if(error||!data?.user){cloudShowGate('Nhập email và mật khẩu chủ trọ để đăng nhập.','login');return;}
    cloudUser=data.user;void cloudLoadAccount();
  }).catch(error=>cloudShowGate('Không kiểm tra được đăng nhập: '+error.message,'login'));
  setInterval(()=>{
    if (!document.hidden && cloudReady && !cloudConflict) void cloudPull();
  },20000);
  window.addEventListener('online',()=>{if(cloudReady&&!cloudConflict)void cloudPull();});
  document.addEventListener('visibilitychange',()=>{
    if(!document.hidden&&cloudReady&&!cloudConflict)void cloudPull();
  });
  window.addEventListener('beforeunload',event=>{
    if(cloudDirty || cloudSending){event.preventDefault();event.returnValue='';}
  });
}
