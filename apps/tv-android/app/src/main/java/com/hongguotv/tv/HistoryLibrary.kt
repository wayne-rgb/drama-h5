package com.hongguotv.tv

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.util.concurrent.TimeUnit

internal fun historyProgress(json:JSONObject)=Progress(Series(json.getString("seriesId"),json.getString("title"),json.optString("cover"),json.optString("description"),json.optString("badge"),json.optString("tags"),json.optString("contentType")),json.getString("episodeId"),json.getInt("episodeNumber"),json.getLong("positionMs"),json.optLong("durationMs"),json.optBoolean("completed"),json.optLong("updatedAt"),json.optString("source","tv"))
internal fun Progress.toHistoryJson():JSONObject=series.toJson().put("seriesId",series.id).put("episodeId",episodeId).put("episodeNumber",episodeNumber).put("positionMs",positionMs).put("durationMs",durationMs).put("completed",completed).put("updatedAt",updatedAt)

/** 观看资料只保存在当前电视；旧版服务端记录仅执行一次迁移。 */
class HistoryLibrary internal constructor(context:Context,libraryOverride:TvLibrary?=null){
    private val application=context.applicationContext
    private val library=libraryOverride?:TvLibrary.get(application)
    private val client=OkHttpClient.Builder().connectTimeout(5,TimeUnit.SECONDS).readTimeout(10,TimeUnit.SECONDS).callTimeout(20,TimeUnit.SECONDS).build()
    private var seriesId=""
    companion object {@Volatile private var singleton:HistoryLibrary?=null;fun get(context:Context)=singleton ?: synchronized(this){singleton ?: HistoryLibrary(context).also{singleton=it}}}
    fun begin(series:Series){seriesId=series.id}
    fun save(record:Progress){if(seriesId==record.series.id)TvStore(application).saveProgress(record)}
    suspend fun list():List<Progress> = withContext(Dispatchers.IO){TvStore(application).history()}
    suspend fun progress(seriesId:String)=list().firstOrNull{it.series.id==seriesId}
    suspend fun migrate(store:TvStore)=withContext(Dispatchers.IO){
        if(library.setting("legacyServerHistoryMigrated")=="1"||store.baseUrl.isBlank())return@withContext
        val result=request(store.baseUrl,"/api/history?source=all")
        library.transaction {
            result.getJSONArray("items").objects().forEach{record->
                val current=library.rows("history").firstOrNull{it.getString("key")==record.getString("seriesId")}
                if(current==null||current.getLong("at")<record.optLong("updatedAt"))library.write("history",record.getString("seriesId"),"set",record,record.optLong("updatedAt"))
            }
            library.setSetting("legacyServerHistoryMigrated","1")
        }
    }
    private fun request(origin:String,path:String):JSONObject{
        val request=Request.Builder().url(origin.trimEnd('/')+path).build()
        client.newCall(request).execute().use{response->val value=JSONObject(response.body?.string()?:"{}");check(response.isSuccessful){value.optString("error","连接失败 ${response.code}")};return value}
    }
}
