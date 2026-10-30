(() => {
  "use strict";

  const DAYS = ["月", "火", "水", "木", "金", "土"];
  const dataset = window.WCV_TIMETABLE || { courses: [] };
  const timetable = document.getElementById("timetable");

  const VIEWS = {
    setagaya: {
      title: "世田谷キャンパス・学部",
      description: "電気電子通信・医用工学・情報科学などの表示例",
      codes: [
        "saa141105",
        "saa131215",
        "saa142102",
        "saa122302",
        "saa113101",
        "saa133203",
        "saa134311",
        "sab132501"
      ],
      changed: ["saa131215", "saa134311"]
    },
    yokohama: {
      title: "横浜キャンパス・学部",
      description: "環境・メディア・情報系学科の表示例",
      codes: [
        "yaa611101",
        "yaa612201",
        "yaa613102",
        "yaa615101",
        "yab615302",
        "saz004521"
      ],
      changed: ["yaa612201"]
    },
    graduate: {
      title: "大学院・研究科横断",
      description: "総合理工・環境情報・情報データ科学・共同原子力の表示例",
      codes: [
        "ymab210005",
        "smaa030081",
        "ymaa110141",
        "ymab210008",
        "smaz060031",
        "smaz090041",
        "ymaa211004"
      ],
      changed: ["smaa030081"]
    }
  };

  const CATEGORY_CLASS = {
    "専門科目": "specialist",
    "基礎科目": "foundation",
    "実験・演習": "exercise",
    "情報・通信": "information"
  };

  const standardPeriods = dataset.dataset?.periodProfiles?.standard?.periods || {};
  const PERIODS = [1, 2, 3, 4, 5].map((period) => ({
    period,
    time: standardPeriods[String(period)]
      ? `${standardPeriods[String(period)].start}〜${standardPeriods[String(period)].end}`
      : ""
  }));

  function createElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text != null) element.textContent = text;
    return element;
  }

  function shortTeachers(instructors) {
    const list = instructors || [];
    if (list.length <= 2) return list.join("・") || "未登録";
    return `${list.slice(0, 2).join("・")} ほか${list.length - 2}名`;
  }

  function departmentLabel(course) {
    const labels = (course.departments || []).map((department) => department.label).filter(Boolean);
    if (!labels.length) return course.level || "所属未登録";
    return `${course.level || ""}・${labels.slice(0, 1).join("/")}`.replace(/^・/, "");
  }

  function meetingTime(meeting) {
    const profileName = meeting.timeProfile || "standard";
    const profile = dataset.dataset?.periodProfiles?.[profileName]?.periods || standardPeriods;
    const period = profile[String(meeting.period)];
    return period ? `${period.start}〜${period.end}` : "";
  }

  function createCourseCard(course, meeting, changedCodes) {
    const categoryClass = CATEGORY_CLASS[course.category] || "specialist";
    const specialProfile = meeting.timeProfile && meeting.timeProfile !== "standard";
    const card = createElement("article", `course-card ${categoryClass}${specialProfile ? " special-time" : ""}`);
    card.title = [
      course.courseName,
      `講義コード: ${course.courseCode}`,
      `教室: ${meeting.room || "未登録"}`,
      `担当: ${(course.instructors || []).join("・") || "未登録"}`,
      `所属: ${departmentLabel(course)}`
    ].join("\n");

    const identity = createElement("div", "course-identity");
    identity.append(
      createElement("span", "course-code", course.courseCode || "コードなし"),
      createElement("span", "course-department", departmentLabel(course))
    );
    card.append(identity, createElement("h3", "", course.courseName));
    card.append(createElement("span", "category-label", course.category || "授業"));

    const meta = createElement("div", "course-meta");
    const room = createElement("div", "room");
    room.append(createElement("i", ""), createElement("span", "", `教室：${meeting.room || "未登録"}`));
    const teacher = createElement("div", "teacher");
    teacher.append(createElement("i", ""), createElement("span", "", `担当：${shortTeachers(course.instructors)}`));
    const campus = createElement("div", "campus");
    campus.append(createElement("i", ""), createElement("span", "", `場所：${meeting.campus || (course.campuses || []).join(" / ") || "未登録"}`));
    meta.append(room, teacher, campus);

    if (specialProfile) {
      const time = createElement("div", "special-profile");
      time.append(createElement("i", ""), createElement("span", "", `専用時限：${meetingTime(meeting)}`));
      meta.append(time);
    } else if (meeting.startsAtNine) {
      const time = createElement("div", "starts-nine");
      time.append(createElement("i", ""), createElement("span", "", "9:00開始"));
      meta.append(time);
    }
    card.append(meta);

    if (changedCodes.has(course.courseCode)) {
      card.append(createElement("span", "change-badge", "変更あり（デモ）"));
    }

    return card;
  }

  function render(viewName) {
    const view = VIEWS[viewName] || VIEWS.setagaya;
    const codeSet = new Set(view.codes);
    const changedCodes = new Set(view.changed);
    const courses = (dataset.courses || []).filter((course) => codeSet.has(course.courseCode));
    const slots = new Map();

    for (const course of courses) {
      for (const meeting of course.meetings || []) {
        const key = `${meeting.day}-${meeting.period}`;
        if (!slots.has(key)) slots.set(key, []);
        slots.get(key).push({ course, meeting });
      }
    }

    timetable.replaceChildren();
    timetable.append(createElement("div", "grid-cell day-header", ""));
    for (const day of DAYS) timetable.append(createElement("div", "grid-cell day-header", `${day}曜日`));

    for (const periodInfo of PERIODS) {
      const periodHeader = createElement("div", "grid-cell period-header");
      periodHeader.append(
        createElement("strong", "", `${periodInfo.period}限`),
        createElement("span", "", periodInfo.time)
      );
      timetable.append(periodHeader);

      for (const day of DAYS) {
        const cell = createElement("div", "grid-cell");
        const entries = slots.get(`${day}-${periodInfo.period}`) || [];
        if (!entries.length) {
          cell.classList.add("empty-cell");
        } else {
          cell.append(createCourseCard(entries[0].course, entries[0].meeting, changedCodes));
          if (entries.length > 1) {
            const more = createElement("div", "more-count", `ほか${entries.length - 1}件`);
            cell.append(more);
          }
        }
        timetable.append(cell);
      }
    }

    document.getElementById("viewTitle").textContent = view.title;
    document.getElementById("viewDescription").textContent = view.description;
    document.getElementById("changeCount").textContent = String(changedCodes.size);
    document.querySelectorAll("[data-view]").forEach((button) => {
      const selected = button.dataset.view === viewName;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-selected", String(selected));
    });
  }

  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => render(button.dataset.view));
  });

  const scope = dataset.dataset?.scope || {};
  const coverage = document.getElementById("coverageSummary");
  if (coverage) {
    const uniqueCourses = Number(scope.uniqueCourses || 0).toLocaleString("ja-JP");
    coverage.textContent = `${uniqueCourses}科目・${scope.sourceDocuments?.length || 0}資料・${scope.timetablePages || 0}頁を収録。`;
  }

  render("setagaya");
})();
