// Data for the leaderboard
const leaderboardData = [
    { platz: 1, spieler: 'Markus', spiele: 153, punkte: 8314, meister: 1, letzter: 0, spieltagssiege: 41, spieltagsletzter: 10, tabellenErster: 52, tabellenLetzter: 3 },
    { platz: 2, spieler: 'Erwin', spiele: 153, punkte: 7807, meister: 1, letzter: 0, spieltagssiege: 20, spieltagsletzter: 11, tabellenErster: 34, tabellenLetzter: 19 },
    { platz: 3, spieler: 'Phil', spiele: 153, punkte: 7604, meister: 1, letzter: 0, spieltagssiege: 29, spieltagsletzter: 29, tabellenErster: 38, tabellenLetzter: 2 },
	{ platz: 4, spieler: 'Eirik', spiele: 153, punkte: 6730, meister: 1, letzter: 1, spieltagssiege: 15, spieltagsletzter: 26, tabellenErster: 6, tabellenLetzter: 32 },
    { platz: 5, spieler: 'Didi', spiele: 153, punkte: 6564, meister: 0, letzter: 2, spieltagssiege: 16, spieltagsletzter: 34, tabellenErster: 1, tabellenLetzter: 62 },
    { platz: 6, spieler: 'Basti', spiele: 119, punkte: 5396, meister: 0, letzter: 0, spieltagssiege: 16, spieltagsletzter: 16, tabellenErster: 1, tabellenLetzter: 2 },
    { platz: 7, spieler: 'Steffo', spiele: 119, punkte: 4896, meister: 0, letzter: 1, spieltagssiege: 4, spieltagsletzter: 25, tabellenErster: 0, tabellenLetzter: 33 },
    { platz: 8, spieler: 'Emil', spiele: 51, punkte: 2968, meister: 0, letzter: 0, spieltagssiege: 7, spieltagsletzter: 1, tabellenErster: 3, tabellenLetzter: 0 },
	{ platz: 9, spieler: 'Espen', spiele: 17, punkte: 1170, meister: 0, letzter: 0, spieltagssiege: 8, spieltagsletzter: 0, tabellenErster: 17, tabellenLetzter: 0},
	{ platz: 10, spieler: 'Kempka', spiele: 17, punkte: 880, meister: 0, letzter: 0, spieltagssiege: 3, spieltagsletzter: 1, tabellenErster: 0, tabellenLetzter: 0 }
    // Additional players can be added here if needed
];

// Data for the highlights section
const highlights = [
    "- Keine Spieltagssiege in der Saison von Emil, Markus, Eirik, Steffo, Didi",			
    "- Keine Spieltagsniederlagen von Espen, Emil, Erwin, Eirik,",
    "- Höchste Spieltagspunkte von Phil mit 104 am 12. Spieltag",
    "- Niedrigste Spieltagspunkte von Phil mit 1 am 7. Spieltag",
    "- 5 Spieltagssiege in Folge Espen",
    "- 2 Spieltagsniederlagen in Folge von Markus, Basti, Didi",
    "- Schlechtester Erster: Basti und Erwin mit 43 Punkten am 15. Spieltag",
    "- Bester Letzter: Didi mit 40 Punkten am 1. Spieltag",
    "- 8 Spieltagssiege von Espen",
    "- 8 Spieltagsniederlagen von Didi",
	 "",
	  "",
	  "",
	  "",
    "Ewig beste Gesamtplatzierungen:",
    "27. Markus mit 108 Punkten 22/23",
    "36. Phil mit 93 Punkten 22/23",
	"108. Phil mit 104 Punkten 24/25",
    "278. Phil mit 91 Punkten 22/23",
    "444. Markus mit 104 Punkten 20/21",
    "614. Phil mit 87 Punkten 22/23",
	"739. Eirik mit 93* Punkten 20/21",
	"766. Phil mit 96 Punkten 21/22",
	"984. Didi mit 91 Punkten 23/24",
	"989. Markus mit 94 Punkten 23/24",
	 "",
	  "",
	  "",
	  "",
    "Ewige statistiken:",
    "- Meiste Spieltagssiege in einer Saison vom Markus mit 13 (21/22)",
    "- Meiste Spieltagsniederlagen in einer Saison von Steffo mit 15 (21/22)",
    "- Ewig wenigste Punkte für Spieltagssieg von Erwin mit 31* Punkten (20/21)",
    "- Ewig wenigste Punkte von Phil mit -9 (22/23) (nur 20 Leute haben weniger punkte gemacht)",
    "- Ewig Höchstpunktzahl von Emil mit 113 (23/24) (leider nicht unter den Top 1000 an dem Spieltag)",
	 "",
	  "",
	  "",
	  "",
    "- Meister 2021: Eirik mit 1847* Punkten (1609 Ø Punkte in der Liga)",
    "- Meister 2022: Phil mit 1826 Punkten (1481 Ø Punkte in der Liga)",
    "- Meister 2023: Erwin mit 1957 Punkten (1541 Ø Punkte in der Liga)",
    "- Meister 2024: Markus mit 2224 Punkten (1799 Ø Punkte in der Liga)",
	"",
	"",
	"",
	
    "*in der Saison 20/21 gab es nur zwei Punkte für Startelf und einen für Einwechslung, habe alles nachgeschaut und an die fehlende Punkte addiert"
	"Seit der Saison gibt es Zwei punkte für eine Vorlage anstelle von Einem. Ist mir Wurst, werde das nicht neu nachrechnen!"
];

// Populate leaderboard table
const leaderboardTable = document.getElementById("leaderboard");
leaderboardData.forEach(player => {
    const row = document.createElement("tr");
    Object.values(player).forEach(value => {
        const cell = document.createElement("td");
        cell.textContent = value;
        row.appendChild(cell);
    });
    leaderboardTable.appendChild(row);
});

// Populate highlights list
const highlightList = document.getElementById("highlight-list");
highlights.forEach(highlight => {
    const listItem = document.createElement("li");
    listItem.textContent = highlight;
    highlightList.appendChild(listItem);
});
