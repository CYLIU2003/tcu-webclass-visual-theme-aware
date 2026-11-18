(() => {
  "use strict";

  const prefix = "planner-task:";
  const validDate = (value) => value === "" || (/^20\d{2}-\d\d-\d\d$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value);
  function valid(key, value) {
    return /^planner-task:[a-f0-9-]{36}$/.test(key)
      && typeof value?.title === "string" && value.title.trim().length > 0 && value.title.length <= 120
      && typeof value.date === "string" && validDate(value.date)
      && typeof value.course === "string" && /^(?:[a-z][a-z0-9]{4,14})?$/.test(value.course)
      && typeof value.done === "boolean";
  }

  function initialize(data, planPrefix, getCourse) {
    const stored = { ...data };
    const form = document.getElementById("planner-task-form");
    const list = document.getElementById("planner-task-list");
    const message = document.getElementById("planner-task-status");
    const coursePicker = form.elements.course;
    const renderCourses = () => {
      const selected = coursePicker.value;
      const courses = Object.keys(stored).filter((key) => key.startsWith(planPrefix) && stored[key] === true)
        .map((key) => getCourse(key.slice(planPrefix.length))).filter(Boolean);
      coursePicker.replaceChildren(new Option("指定しない", ""), ...courses.map((course) =>
        new Option(`${course.courseName}（${course.courseCode}）`, course.courseCode)));
      if (courses.some((course) => course.courseCode === selected)) coursePicker.value = selected;
    };

    async function save(control, operation) {
      control.disabled = true;
      try {
        await operation();
        message.textContent = "課題メモを保存しました。";
      } catch {
        message.textContent = "保存できませんでした。もう一度お試しください。";
        control.disabled = false;
        render();
      }
    }

    function render() {
      const entries = Object.entries(stored).filter(([key, value]) => valid(key, value))
        .sort(([, a], [, b]) => Number(a.done) - Number(b.done) || (a.date || "9999").localeCompare(b.date || "9999"));
      const activeTask = document.activeElement?.dataset?.task;
      list.replaceChildren();
      for (const [key, task] of entries) {
        const item = document.createElement("li");
        const label = document.createElement("label");
        const done = document.createElement("input");
        done.type = "checkbox";
        done.checked = task.done;
        done.dataset.task = key;
        label.append(done, task.title);
        const details = document.createElement("span");
        details.textContent = [task.done ? "完了" : "未完了", task.date || "締切日なし",
          getCourse(task.course)?.courseName || task.course].filter(Boolean).join(" · ");
        const remove = document.createElement("button");
        remove.type = "button";
        remove.textContent = "削除";
        remove.setAttribute("aria-label", `${task.title}を削除`);
        done.addEventListener("change", () => save(done,
          () => chrome.storage.local.set({ [key]: { ...task, done: done.checked } })));
        remove.addEventListener("click", () => save(remove, () => chrome.storage.local.remove(key)));
        item.append(label, details, remove);
        list.append(item);
        if (key === activeTask) done.focus();
      }
      if (!entries.length) {
        const empty = document.createElement("li");
        empty.textContent = "課題メモはありません。";
        list.append(empty);
      }
    }

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const key = prefix + crypto.randomUUID();
      const task = {
        title: form.elements.title.value.trim(), date: form.elements.date.value, course: coursePicker.value, done: false
      };
      if (!valid(key, task)) {
        message.textContent = "課題名と締切日を確認してください。";
        return;
      }
      await save(event.submitter, async () => {
        await chrome.storage.local.set({ [key]: task });
        form.reset();
      });
      event.submitter.disabled = false;
      form.elements.title.focus();
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      const entries = Object.entries(changes);
      for (const [key, change] of entries) stored[key] = change.newValue;
      if (entries.some(([key]) => key.startsWith(planPrefix))) renderCourses();
      if (entries.some(([key]) => key.startsWith(prefix))) render();
    });
    renderCourses();
    render();
  }

  globalThis.WCV_PLANNER_TASKS = { initialize, valid };
})();
