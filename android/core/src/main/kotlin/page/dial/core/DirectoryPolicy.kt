package page.dial.core

object JsonPolicy {
    fun validDepth(depth: Int): Boolean = depth >= 0 && depth < DirectoryLimits.MAXIMUM_JSON_DEPTH
}

object PagePolicy {
    fun canAppend(more: Boolean, sameQuery: Boolean): Boolean = more && sameQuery

    fun <T> restart(more: Boolean, previous: T?, received: T?): Boolean =
        more && previous != received
}

object TransferPolicy {
    fun chunk(received: Long, count: Long, expected: Long): Boolean =
        received >= 0 && count >= 0 && received <= expected && count <= expected - received

    fun copy(start: Long, count: Long, base: Long): Boolean =
        start >= 0 && count >= 1 && count <= base && start <= base - count
}

enum class GenerationPhase {
    Receiving,
    Indexed,
    Uncertain,
    Complete,
}

object PublicationPolicy {
    fun canActivate(phase: GenerationPhase, valid: Boolean): Boolean =
        phase == GenerationPhase.Indexed && valid

    fun canDiscard(phase: GenerationPhase): Boolean =
        phase != GenerationPhase.Uncertain && phase != GenerationPhase.Complete

    fun <T> select(
        active: T?,
        candidate: T,
        phase: GenerationPhase,
        valid: Boolean,
        observedCandidate: Boolean,
    ): T? =
        if (!valid) active
        else if (phase == GenerationPhase.Complete) candidate
        else if (phase == GenerationPhase.Uncertain && observedCandidate) candidate else active
}

object WordPolicy {
    const val PLACE_RANK = 3

    fun rank(words: Int, named: Int, placed: Int, rank: Int): Int? =
        if (named + placed < words) null
        else if (named < words) PLACE_RANK else if (words == 1) rank else 2
}

object CallerPolicy {
    const val LOOKUP_BUDGET_MILLIS = 1000L

    fun display(started: Long, now: Long, found: Boolean, held: Boolean): Boolean =
        started >= 0 && now >= started && now - started < LOOKUP_BUDGET_MILLIS && found && held
}
