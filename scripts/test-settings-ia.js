// scripts/test-settings-ia.js — ST10 information-architecture pins.
//
// The Operations page was dissolved: Knowledge base -> My Business,
// email connection -> Settings (vertical-neutral copy), PM response
// mode -> My Business (both conduct cards vertical-gated), the nav
// entry/page/tile gone, positional nth-child nav selectors converted
// to id-based. These rows pin that end-state so a later edit can't
// silently resurrect Operations or re-strand a conduct card.
const path = require('path');
const fs = require('fs');

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}

const app = fs.readFileSync(path.join(__dirname, '..', 'views', 'app.html'), 'utf8');
const between = (start, end) => {
  const a = app.indexOf(start), b = app.indexOf(end, a + 1);
  return (a >= 0 && b > a) ? app.slice(a, b) : '';
};
const myBusiness = between('id="page-my-business"', 'id="page-menu"');
const settings = between('id="page-admin"', 'id="page-finances"');

(function () {
  // ---- IA1: Operations is fully gone ----
  {
    const noNav = !app.includes('id="nav-operations"');
    const noPage = !app.includes('id="page-operations"');
    const noTile = !app.includes('quick-tile-title">Operations<');
    const noShowPage = !/showPage\('operations'/.test(app);
    const noMaps = !app.includes("operations: '") && !app.includes("'my-business', 'operations'");
    check('IA1: the Operations page is fully dissolved — no nav entry, no page shell, no home tile, no showPage(operations), no icon/title/TOOL_PAGE_MAP references',
      noNav && noPage && noTile && noShowPage && noMaps,
      JSON.stringify({ noNav, noPage, noTile, noShowPage, noMaps }));
  }

  // ---- IA2: Knowledge base lives on My Business ----
  {
    const kbHere = myBusiness.includes('id="knowledgeList"')
      && myBusiness.includes('id="kbForm"') && myBusiness.includes('Knowledge base');
    // and the loader fires on My Business open (comment block sits
    // between the fn open and the call, so allow generous span)
    const wired = /async function loadMyBusinessPage\(\)[\s\S]{0,700}loadKnowledge\(\)/.test(app);
    check('IA2: the Knowledge base document manager lives on My Business (list + form + upload) and loadKnowledge fires on page open',
      kbHere && wired, JSON.stringify({ kbHere, wired }));
  }

  // ---- IA3: email connection lives in Settings, vertical-neutral ----
  {
    const emailHere = settings.includes('id="emailConnForm"') && settings.includes('Business email connection');
    const neutral = !app.includes('Property email connection')
      && !app.includes('mypropertyapartments@') && !app.includes('sunsetapartmentsmgr@')
      && !app.includes('yourproperty@gmail');
    check('IA3: the email connection card lives in Settings, titled "Business email connection", with zero property-framed copy remaining',
      emailHere && neutral, JSON.stringify({ emailHere, neutral }));
  }

  // ---- IA4: both conduct cards on My Business, vertical-gated ----
  {
    const bothHere = myBusiness.includes('id="mbConductPS"') && myBusiness.includes('id="mbConductPM"');
    // gating: applyVerticalVisibility shows PS card for PS, PM card for PM
    const gated = /conductPS\.style\.display = isPS \? '' : 'none'/.test(app)
      && /conductPM\.style\.display = isPS \? 'none' : ''/.test(app);
    // the PM card defaults hidden (revealed only for PM)
    const pmDefaultsHidden = /id="mbConductPM"[^>]*display:none/.test(app);
    check('IA4: both conduct cards (PS "How your assistant works", PM "Automation settings") live on My Business and are vertical-gated — PS-only and PM-only — with the PM card defaulting hidden',
      bothHere && gated && pmDefaultsHidden,
      JSON.stringify({ bothHere, gated, pmDefaultsHidden }));
  }

  // ---- IA5: no positional nav selectors survive ----
  {
    const noNthChild = !/nav a:nth-child/.test(app);
    // every former positional selector is now id-based
    const idBased = (app.match(/getElementById\('nav-/g) || []).length >= 8;
    check('IA5: no positional #sidebar nav a:nth-child selectors remain — all converted to id-based getElementById(nav-…), robust to nav changes',
      noNthChild && idBased, JSON.stringify({ noNthChild, idBased }));
  }

  // ---- IA6: the moved ids are each unique (no move duplicated markup) ----
  {
    const ids = ['knowledgeList', 'kbForm', 'emailConnForm', 'connEmail', 'autoReply', 'requireReview', 'mbConductPM', 'mbConductPS'];
    const dupes = ids.filter((id) => (app.split('id="' + id + '"').length - 1) !== 1);
    check('IA6: every relocated id appears exactly once — no move left a duplicate behind',
      dupes.length === 0, 'duplicated/missing: ' + JSON.stringify(dupes));
  }

  console.log(`${pass}/${pass + fail} — settings-ia gate ${fail ? 'FAILED' : 'PASSED'}`);
  process.exit(fail ? 1 : 0);
})();
