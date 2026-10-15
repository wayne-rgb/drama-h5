package com.hongguotv.tv

import org.junit.Assert.*
import org.junit.Test
import org.json.JSONObject

class HistoryWireTest {
    @Test fun keepsStringIdsAndMillisecondsInLegacyHistoryImports() {
        val record = historyProgress(JSONObject("""{"seriesId":"9007199254740999","title":"剧","episodeId":"9007199254740998","episodeNumber":2,"positionMs":12345,"durationMs":50000,"completed":false,"updatedAt":123,"source":"pc"}"""))
        assertEquals("9007199254740999", record.series.id)
        assertEquals("pc", record.source)
        assertEquals(12345L, record.positionMs)
        assertEquals("9007199254740998", record.toHistoryJson().getString("episodeId"))
    }
}
