// NOT COMPILED YET against your engine version. See docs/MAPLE_COURT.md.
#pragma once

#include "CoreMinimal.h"
#include "Subsystems/WorldSubsystem.h"
#include "Dom/JsonObject.h"
#include "MVWBackendSubsystem.h"
#include "MVWMapleCourt.generated.h"

class AStaticMeshActor;
class UStaticMesh;
class UMaterialInterface;
class UMaterialInstanceDynamic;
class APawn;

/**
 * Maple Court: the first playable neighbourhood, built at runtime from basic cubes (greybox).
 * It needs no level editing: when a game world starts, this subsystem spawns the buildings in a zone far from the
 * template level and moves players there.
 *
 *   - Apartment door   [E]  rent a free room (500 MVC) / enter if you rent it  -> backend: access check + rent
 *   - Shop counter     [E]  buy a Sandwich, [R] buy Water                      -> backend: purchase
 *   - Work station     [E]  start a shift, then do tasks, shift pays at the end -> backend: shifts
 *
 * Dev scope: interactions work for the Standalone / Listen-Server host (which acts as "the server" and holds
 * MVW_SERVER_KEY). Connected clients see the buildings but interactions need the RPC layer (next milestone).
 */
UCLASS()
class MVWBACKEND_API UMVWMapleCourtSubsystem : public UTickableWorldSubsystem
{
	GENERATED_BODY()

public:
	virtual bool ShouldCreateSubsystem(UObject* Outer) const override;
	virtual void OnWorldBeginPlay(UWorld& InWorld) override;
	virtual void Deinitialize() override;
	virtual void Tick(float DeltaTime) override;
	virtual TStatId GetStatId() const override;

private:
	enum class EZone : uint8 { None, Door, Counter, Work };

	// ---- world building ----
	void BuildCourt();
	AStaticMeshActor* SpawnBox(const FVector& Center, const FVector& SizeCm, const FLinearColor& Color);
	void BuildRoomBox(const FVector& Center2D, float SizeX, float SizeY, float Height, bool bDoorOnPositiveY, float DoorWidth,
		const FLinearColor& WallColor, const FLinearColor& FloorColor, bool bWithDoorPanel);
	void AddLabel(const FVector& Loc, const FString& Text, const FColor& Color);
	void SetDoorOpen(bool bOpen);

	// ---- per-frame ----
	void TeleportNewPawns();
	void DrawLabels() const;
	void UpdateInteraction();
	void UpdateHud();
	EZone NearestZone(const FVector& PawnLoc) const;
	FString PromptFor(EZone Zone) const;

	// ---- backend session ----
	void StartSession(bool bFreshIdentity);
	bool LoadIdentity();
	void SaveIdentity() const;
	void DoRegisterThenLogin();
	void DoLogin();
	void DoEnsureCharacter(int32 Attempt);
	void DoTicketAndRedeem();
	void DoPickProperty();
	void RefreshSummary();
	void ApplySummary(const TSharedPtr<FJsonObject>& Summary);
	void Call(const FString& Verb, const FString& Path, TSharedPtr<FJsonObject> Body, bool bAsPlayer, TFunction<void(const FMVWBackendResult&)> Done);
	UMVWBackendSubsystem* Backend() const;
	FString CharPath(const FString& Suffix) const;

	// ---- actions ----
	void OnDoorUse();
	void OnBuy(const FString& ItemId, const FString& Label);
	void OnWorkUse();
	void Say(const FString& Text, const FColor& Color = FColor::White);
	static FString Friendly(const FMVWBackendResult& R);

	// ---- state ----
	UPROPERTY(Transient) TObjectPtr<UStaticMesh> CubeMesh;
	UPROPERTY(Transient) TObjectPtr<UMaterialInterface> BaseMaterial;
	UPROPERTY(Transient) TArray<TObjectPtr<UMaterialInstanceDynamic>> Materials;
	UPROPERTY(Transient) TObjectPtr<AStaticMeshActor> DoorPanel;

	struct FLabel { FVector Loc; FString Text; FColor Color; };
	TArray<FLabel> Labels;
	TSet<TWeakObjectPtr<APawn>> Teleported;

	FVector Origin = FVector(100000.0, 0.0, 0.0);
	FVector DoorZoneLoc = FVector::ZeroVector;
	FVector CounterZoneLoc = FVector::ZeroVector;
	FVector WorkZoneLoc = FVector::ZeroVector;
	bool bDoorOpen = false;
	double DoorCloseAt = 0.0;

	bool bBackendSession = false;   // this world drives the backend (standalone / listen-server host)
	bool bSessionReady = false;
	bool bBusy = false;
	bool bRetriedFresh = false;
	FString Email, Password, PlayerToken, CharacterId, DisplayName;

	// cached from the backend summary
	int64 Balance = 0;
	FString HomeText = TEXT("none"), BackpackText = TEXT("empty"), ShiftText = TEXT("no shift");
	FString TenantPropertyId;
	FString ShiftId; int32 ShiftDone = 0, ShiftRequired = 0;
	FString DoorPropertyId, DoorPropertyName; int64 DoorRent = 0;

	FString LastMessage; FColor LastColor = FColor::White; double LastMessageUntil = 0.0;
};
