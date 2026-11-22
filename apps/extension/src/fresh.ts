// 돌고 있는 확장 코드가 디스크에 깔린 새 코드와 같은지 (scripts/build.mjs의 빌드 지문).
// 버전 번호가 같으면 Chrome은 새로 깐 파일을 읽지 않고 예전 서비스 워커를 계속 돌린다(11-22: 탭 정리가 없는 예전 코드라 탭 72개).
// 다르면 스스로 다시 켠다 (다시 켜면 디스크의 새 코드가 돈다)

/** 다시 켜야 하나: 둘 다 알고, 서로 다를 때만 (개발 빌드·파일 없음은 그대로 둔다) */
export function staleBuild(running: string | undefined, onDisk: string | undefined): boolean {
  if (!running || !onDisk || running === 'dev') return false
  return running !== onDisk
}
