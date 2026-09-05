export function inferTopic(prompt: string): string {
  const lower = prompt.toLocaleLowerCase();
  const rules: Array<[string, RegExp]> = [
    ["데이터", /(첫\s*결제|재구매|결제자|이탈\s*(유저|사용자)?\s*분석|세그먼트|코호트|퍼널|리텐션|전환율|재방문율|이탈률|결제율|사용자\s*지표|유저\s*지표|raw\s*데이터|원천\s*데이터|행동\s*데이터|이벤트\s*데이터|데이터(?!베이스).{0,20}(분석|통계|집계|추출|시각화)|통계\s*분석|a\/b\s*테스트)/iu],
    ["개발", /(개발|코드|소스|구현|수정|고쳐|변경|추가|삭제|만들어|개편|연동|마이그레이션|버그|오류|에러|실패|디버그|테스트|배포|브랜치|pull request|\bpr\b|ci|cd|api|endpoint|서버|백엔드|프론트엔드|데이터베이스|db|sql|쿼리|스키마|리팩터|빌드|패키지|라이브러리|의존성|컴포넌트|페이지|화면|대시보드|앱|웹|git|github|ui|ux|스크립트|터미널|tmux|vim|\.tsx?\b|\.jsx?\b|\.py\b|\.go\b|\.rs\b|\.swift\b|\.java\b|\.json\b|\.ya?ml\b|\.toml\b|\.sh\b)/iu],
    ["마케팅", /(마케팅|콘텐츠|캠페인|광고|브랜드|seo|sns|소셜|업로드|홍보|고객)/iu],
    ["문서", /(문서|readme|가이드|매뉴얼|번역|작성|회의록)/iu],
    ["분석", /(분석|조사|리서치|통계|지표|데이터|비교|검토)/iu],
    ["기획", /(기획|계획|로드맵|요구사항|설계|아이디어)/iu],
  ];
  return rules.find(([, pattern]) => pattern.test(lower))?.[0] ?? "기타";
}
