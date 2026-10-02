// JSON 파일 하나에 저장하는 단순 저장소. (DB 설치 불필요)
// file 이 null 이면 메모리 전용(테스트용).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export class Store {
  constructor(file = null) {
    this.file = file;
    this.data = { services: [] };
    if (file) this.load();
  }

  load() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    if (!fs.existsSync(this.file)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (parsed && Array.isArray(parsed.services)) this.data = parsed;
      else throw new Error('형식 오류');
    } catch (e) {
      // 깨진 파일은 지우지 않고 보관한 뒤 빈 상태로 시작 (서버가 죽지 않도록)
      const backup = `${this.file}.corrupt-${Date.now()}`;
      fs.renameSync(this.file, backup);
      console.error(`[store] 데이터 파일을 읽지 못해 ${backup} 로 옮겼습니다: ${e.message}`);
    }
  }

  save() {
    if (!this.file) return;
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file); // 쓰다 죽어도 원본이 깨지지 않게 교체 방식
  }

  list() {
    return this.data.services;
  }

  get(id) {
    return this.data.services.find((s) => s.id === id) || null;
  }

  findByManageKey(key) {
    const h = sha256(String(key));
    return this.data.services.find((s) => s.manageKeyHash === h) || null;
  }

  add(service) {
    this.data.services.push(service);
    this.save();
    return service;
  }

  remove(id) {
    const before = this.data.services.length;
    this.data.services = this.data.services.filter((s) => s.id !== id);
    this.save();
    return this.data.services.length < before;
  }
}
