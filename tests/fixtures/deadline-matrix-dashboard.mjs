const scenario = structuredClone(parent.matrixScenario);
const load = ++parent.matrixLoad;
const maxDelay = Math.max(0, ...scenario.courses.flatMap(course => course.tables.map(table => table.delay)));
document.title = '課題実施状況一覧（模擬環境）';
const app = document.createElement('main');
document.body.append(app);
const headerNames = { title: '教材', due: '締切', executed: '実施日', score: '最高点', status: '状態' };

for (const course of scenario.courses) {
  if (course.absent) continue;
  const block = document.createElement('section');
  const heading = document.createElement('h2');
  const link = document.createElement('a');
  link.href = course.href || `/webclass/course.php/${course.id}/login`;
  link.textContent = course.name;
  heading.append(link);
  block.append(heading);
  app.append(block);
  for (const spec of course.tables) {
    const wrap = document.createElement('div');
    const table = document.createElement('table');
    const columns = spec.layout === 'reordered' ? ['status', 'score', 'title', 'executed', 'due'] : ['title', 'due', 'executed', 'score', 'status'];
    const head = spec.layout === 'header-in-body' ? table.createTBody() : table.createTHead();
    if (spec.layout === 'multi-header') {
      const caption = head.insertRow();
      const cell = document.createElement('th');
      cell.colSpan = columns.length;
      cell.textContent = '教材の実施状況';
      caption.append(cell);
    }
    const header = head.insertRow();
    for (const column of columns) {
      const cell = document.createElement('th');
      cell.textContent = headerNames[column];
      header.append(cell);
    }
    const body = spec.layout === 'header-in-body' ? head : table.createTBody();
    wrap.append(table);
    block.append(wrap);
    if (spec.busyUntil) {
      wrap.setAttribute('aria-busy', 'true');
      setTimeout(() => wrap.setAttribute('aria-busy', 'false'), spec.busyUntil);
    }
    if (spec.delay < 0) continue;
    const delay = scenario.repeats > 1 ? (load % 2 ? spec.delay : maxDelay - spec.delay) + ((load * 131 + course.id.length * 79) % 650) : spec.delay;
    setTimeout(() => {
      if (!spec.rows.length) {
        const cell = body.insertRow().insertCell();
        cell.colSpan = columns.length;
        cell.textContent = '教材はありません。';
      }
      const rows = load % 2 ? [...spec.rows].reverse() : spec.rows;
      for (const material of rows) {
        const row = body.insertRow();
        for (const column of columns) {
          const cell = row.insertCell();
          if (column === 'title') {
            if (material.href) {
              const anchor = document.createElement('a');
              anchor.href = material.href;
              anchor.textContent = material.title;
              cell.append(anchor);
            } else cell.textContent = material.title;
          } else if (column === 'due') cell.textContent = material.rawDeadline;
          else if (column === 'executed') cell.textContent = material.executed || '-';
          else if (column === 'score') cell.textContent = material.score || '架空の成績（表示対象外）';
          else cell.textContent = material.status;
        }
      }
      if (spec.layout === 'direct-rows') {
        table.append(...Array.from(body.rows));
        body.remove();
      }
    }, delay);
  }
}
